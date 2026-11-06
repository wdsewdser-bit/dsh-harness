import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTeamProfile } from '../../profiles/index.mjs';
import { simulateMailboxRequests } from './simulated-mailbox-requests.mjs';
const activeProfiles=new Map(),failedProfiles=new Set();
export function profileDiagnostics(){return [...activeProfiles].map(([root,ctx])=>{
 const r=ctx.teamRuntime;try{return {root,turnEvents:r?.turnDiagnostics,scopeHistory:r?.store?.events().filter(e=>e.entity.startsWith(
   'execution-scope:')).slice(-80),scopes:r?.executionScopes?.all().map(s=>s.snapshot()),effects:r?.store?.effects().map(e=>({id:e.id,status:e.status,kind:
   e.payload?.kind,attemptId:e.payload?.attemptId,lastEvidence:e.lastEvidence})),attempts:r?.store?.list('attempt:'),mailboxReleases:r?.mailboxReleases,host:
   r?.host?.status(),cycle:r?.host?.cycle?.status(),runtime:r?.status()};}catch(error){return {root,error:error.message};}
});}
export const until = async predicate => {
 for(let i=0;i<300;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
 for(const root of activeProfiles.keys())failedProfiles.add(root);
 const diagnostics=profileDiagnostics(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-profile-timeout-')),file=path.join(directory,'terminal.json');
 fs.writeFileSync(file,JSON.stringify({at:Date.now(),diagnostics},null,2));
 const error=Object.assign(Error('profile acceptance timeout; diagnostics='+file),{diagnostics,file});
 console.error('PROFILE_TIMEOUT '+JSON.stringify({file,diagnostics}));throw error;
};
export async function profile(options = {}, prepare = null) {
 const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'f1-accept-'));
 // agentGuards captures what the profile hands to ctx.tools.guard: the same guard a native tool call passes through,
 // so a test can push a real call down that pipeline instead of calling the guard class directly.
 const listeners = new Map(), sessions = new Map(), agentTools = new Map(), agentGuards = new Map(), globalTools = new Map(), agentMetas = [];
 const ctx = { goals: { registerCompletionGuard: () => () => {} }, tools: { register(tool) {globalTools.set(tool.name,tool);} },
  sessions: { get: id => sessions.get(id), async create(id) { const session={id,seq:0,snapshotEvents:()=>[]};sessions.set(id,session);return session; } },
    llm: { isAgentLoopRequest: () => true },
  get(name) { return this[name]; }, provide(name,value) { this[name]=value; }, async emit(name,...args) { for(const fn of [...(listeners.get(name)??[
    ])]) await fn(...args); },
  on(name,fn) { const set=listeners.get(name)??new Set(); set.add(fn); listeners.set(name,set); return ()=>set.delete(fn); },
  agents: { async create(options = {}) { const session={ id:'session:worker',seq:0,snapshotEvents:()=>[] }; sessions.set(session.id,session); agentMetas.push(
    { ...(options.meta ?? {}) });
   return { agent: { session,ctx:{ tools:{register(tool){agentTools.set(tool.name,tool);},restrict(){},guard(fn){const list=agentGuards.get(session.id)??[];
     list.push(fn);agentGuards.set(session.id,list);return ()=>{};}} },wakeDriver(){},cancel(){},async whenIdle(){} },async dispose(){} }; } } };
 if (prepare) await prepare({ root, ctx, sessions });
 const { simulateRequests = false, ...configuration } = options;
 applyTeamProfile(ctx,{root,lifecycleIntervalMs:10,...configuration});
 try { await ctx.teamRuntime.ready; } catch(error) { ctx.teamRuntime.store?.close(); throw error; }
 if (simulateRequests) simulateMailboxRequests(ctx.teamRuntime);
 activeProfiles.set(root,ctx);
 return { root,ctx,sessions,listeners,agentTools,agentGuards,globalTools,agentMetas,get runtime(){return ctx.teamRuntime;}, async close({remove=true}={}){
   activeProfiles.delete(root);await ctx.teamRuntime.stop(); if(remove&&!failedProfiles.has(root))fs.rmSync(root,{recursive:true,force:true}); } };
}
