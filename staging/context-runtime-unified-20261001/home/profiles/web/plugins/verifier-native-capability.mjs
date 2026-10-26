import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { FsError, FsTargetKey, FsVersion } from '../../../../app/node_modules/@deepseek-ai/dsh-fs/lib/index.js';
import { apply as observationPolicy } from '../../../../app/node_modules/@deepseek-ai/dsh-fs-observation-policy/lib/index.js';
import { openHandleBridge } from './verifier-native-transport.mjs';

export const name='verifier-native-capability';
export const inject=['fs','tools','agentTeams'];
const reserved=value=>typeof value==='string'&&/(?:^|[\\/])\.dsh-verifier-scratch(?:[\\/]|$)/iu.test(value);
const inside=(root,value)=>{const relative=path.relative(root,value);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const normalized=text=>text.replaceAll('\r\n','\n');
const abort=signal=>{if(signal?.aborted)throw new FsError('scratch operation aborted','FS_ABORTED');};

// Explicit opt-in only. This mutates only the isolated host's live service
// object, and restores its methods when the plugin fiber is disposed.
export function apply(ctx,config={}) {
  if(config.enabled!==true)return;
  if(config.isolatedHost!==true||process.platform!=='win32'||process.arch!=='x64')throw new Error('ISOLATED_WINDOWS_X64_HOST_OPT_IN_REQUIRED');
  const native=ctx.fs,actors=new AsyncLocalStorage(),ownedTargets=new WeakMap(),sessions=new WeakMap(),controllers=new Set(),initializing=new Set(),originals=new Map();
  let closing=false;
  const methods=['resolve','stat','lstat','readText','streamText','readBytes','readByteRange','listDir','writeText','editText','processPath','fileUrl','contains','processPathFromHostPath','watch'];
  for(const method of methods)originals.set(method,{descriptor:Object.getOwnPropertyDescriptor(native,method),call:typeof native[method]==='function'?native[method].bind(native):undefined});
  const identity=exec=>{
    const agent=exec?.agent,session=agent?.session;
    if(!agent||!session)throw new FsError('scratch requires an authenticated native agent session','FS_PERMISSION_DENIED');
    const member=ctx.agentTeams.tryMembership(agent),rows=ctx.agentTeams.listMembers(agent);
    if(!member?.id||!Array.isArray(rows)||!rows.some(row=>row.id===agent.id&&row.name===member.name&&row.groupId==='verifier'))throw new FsError('scratch requires current verifier membership','FS_PERMISSION_DENIED');
    const locator=ctx.tools.get('verifier_scratch',agent);
    if(!locator)throw new FsError('native verifier scratch locator unavailable','FS_PERMISSION_DENIED');
    if(typeof session.id!=='string'||!session.id||/[\\/:\0]/u.test(session.id)||session.id==='.'||session.id==='..'||session.id.endsWith('.')||session.id.endsWith(' '))throw new FsError('invalid native session component','FS_PERMISSION_DENIED');
    const workspace=path.resolve(session.header.cwd),root=path.join(workspace,'.dsh-verifier-scratch',session.id);
    const workspaceFileId=fs.lstatSync(workspace,{bigint:true}).ino.toString();
    return{agent,session,sessionId:session.id,agentId:agent.id,teamId:member.id,memberName:member.name,workspace,workspaceFileId,root};
  };
  const assertBound=binding=>{
    if(closing)throw new FsError('scratch adapter is closing','FS_IO_ERROR');
    const current=identity(actors.getStore());
    if(current.agent!==binding.agent||current.session!==binding.session||current.sessionId!==binding.sessionId||current.agentId!==binding.agentId||current.teamId!==binding.teamId||current.memberName!==binding.memberName||current.root!==binding.root||current.workspaceFileId!==binding.workspaceFileId)throw new FsError('scratch controller binding changed','FS_PERMISSION_DENIED');
    return current;
  };
  const checkPolicy=(binding,provided)=>{
    const validate=policy=>{
      if(!policy)throw new FsError('scratch requires a resolved native sandbox policy','FS_SANDBOX_DENIED');
      if(policy.mode==='danger-full-access')return;
      if(policy.mode==='workspace-write'&&typeof policy.workspaceRoot==='string'&&inside(fs.realpathSync.native(policy.workspaceRoot),binding.root))return;
      throw new FsError('scratch mutation denied by the current sandbox policy','FS_SANDBOX_DENIED');
    };
    validate(ctx.get('sandboxPolicy')?.resolve({session:binding.session}));
    if(provided!=null)validate(provided);
  };
  async function controller(binding) {
    assertBound(binding);
    const location=await ctx.tools.get('verifier_scratch',binding.agent).execute({},actors.getStore());
    if(location?.ok!==true||location.ownerSessionId!==binding.sessionId||location.root!==binding.root)throw new FsError('native verifier scratch locator refused authorization','FS_PERMISSION_DENIED');
    assertBound(binding);
    let pending=sessions.get(binding.session);
    if(pending){let value;try{value=await pending;assertBound(value.binding);return value;}catch(error){if(sessions.get(binding.session)===pending)sessions.delete(binding.session);if(value)try{await value.close();}catch(cleanup){error.cause??=cleanup;}throw error;}}
    pending=(async()=>{
      checkPolicy(binding);
      const bridge=await openHandleBridge(binding.root,{bootstrap:{workspace:binding.workspace,workspaceFileId:binding.workspaceFileId,sessionId:binding.sessionId},authorizeBootstrap(){assertBound(binding);checkPolicy(binding);}});
      try{assertBound(binding);checkPolicy(binding);}catch(error){try{await bridge.close();}catch(cleanup){error.cause??=cleanup;}throw error;}
      console.info('[verifier-native-capability] '+JSON.stringify({event:'ready',sessionId:binding.sessionId,root:binding.root,filesystem:bridge.hello.filesystem,expectedFileId:bridge.expectedFileId}));
      const value={binding,rpc:bridge.rpc,tail:Promise.resolve(),closePromise:undefined,close(){return this.closePromise??=(async()=>{try{await this.tail;await bridge.close();}finally{controllers.delete(this);}})();}};
      controllers.add(value);return value;
    })();
    sessions.set(binding.session,pending);
    initializing.add(pending);
    let value;
    try{value=await pending;assertBound(value.binding);return value;}catch(error){if(sessions.get(binding.session)===pending)sessions.delete(binding.session);if(value)try{await value.close();}catch(cleanup){error.cause??=cleanup;}throw error;}finally{initializing.delete(pending);}
  }
  function targetData(target){const data=ownedTargets.get(target);if(!data){if(reserved(target?.displayPath)||reserved(target?.targetKey))throw new FsError('foreign scratch target refused','FS_PERMISSION_DENIED');return undefined;}assertBound(data.binding);return data;}
  async function targetController(target){const data=targetData(target);if(!data)return;const current=await controller(data.binding);assertBound(data.binding);return{...data,current};}
  function serialize(current,operation){const run=current.tail.then(operation,operation);current.tail=run.catch(()=>{});return run;}
  const route={
    async resolve(value,opts={}) {
      const absolute=typeof value==='string'?path.resolve(opts.cwd??actors.getStore()?.agent?.session?.header?.cwd??process.cwd(),value):'';
      if(!reserved(value)&&!reserved(absolute))return originals.get('resolve').call(value,opts);
      abort(opts.signal);const binding=identity(actors.getStore());
      const relative=path.relative(binding.root,absolute);
      if(!inside(binding.root,absolute)||relative.split(/[\\/]/u).some(name=>name.includes(':')||name.endsWith('.')||name.endsWith(' ')))throw new FsError('scratch target outside the authenticated session root','FS_PERMISSION_DENIED');
      const target={targetKey:FsTargetKey(absolute.toLowerCase()),displayPath:absolute};ownedTargets.set(target,{binding,relative});return target;
    },
    async stat(target,signal){const data=await targetController(target);if(!data)return originals.get('stat').call(target,signal);const result=await data.current.rpc('stat',data.relative,{},signal);return result?{type:result.Type,size:result.Size,version:FsVersion(result.Version)}:undefined;},
    async readText(target,signal){const data=await targetController(target);if(!data)return originals.get('readText').call(target,signal);const result=await data.current.rpc('read',data.relative,{},signal);abort(signal);return result.Content;},
    async streamText(target,signal){if(!targetData(target))return originals.get('streamText').call(target,signal);const content=await route.readText(target,signal);return(async function*(){abort(signal);yield content;})();},
    async writeText(target,content,expected,signal,policy){const data=targetData(target);if(!data)return originals.get('writeText').call(target,content,expected,signal,policy);checkPolicy(data.binding,policy);expected??=await policyCallbacks.get('fs/write-intent')(target,actors.getStore());if(typeof content!=='string'||content.includes('\0')||!content.isWellFormed())throw new FsError('well-formed text without NUL required','FS_NOT_TEXT');const current=await controller(data.binding);return serialize(current,async()=>{assertBound(data.binding);checkPolicy(data.binding,policy);abort(signal);if(Buffer.byteLength(content)>4194304)throw new FsError('scratch text exceeds 4 MiB','FS_TOO_LARGE');const parent=path.dirname(data.relative);if(parent!=='.')await current.rpc('mkdir',parent,{},signal);assertBound(data.binding);checkPolicy(data.binding,policy);const result=await current.rpc('write',data.relative,{content,expected},signal);return{...result,version:FsVersion(result.version),before:result.before===null?null:normalized(result.before),after:normalized(result.after)};});},
    async editText(target,edit,expected,signal,policy){const data=targetData(target);if(!data)return originals.get('editText').call(target,edit,expected,signal,policy);checkPolicy(data.binding,policy);if(expected==null){expected=await policyCallbacks.get('fs/edit-intent')(target,actors.getStore());console.info('[verifier-native-capability] '+JSON.stringify({event:'backend-observation-fallback',sessionId:data.binding.sessionId}));}const current=await controller(data.binding);return serialize(current,async()=>{
      assertBound(data.binding);checkPolicy(data.binding,policy);abort(signal);if(!expected?.version)throw new FsError('edit requires reading first','FS_NOT_OBSERVED');
      const before=await current.rpc('read',data.relative,{},signal);if(before.Version!==expected.version)throw new FsError('scratch changed since observation','FS_STALE_VERSION');
      const original=normalized(before.Content),needle=normalized(edit.oldString),replacement=normalized(edit.newString);
      if(!needle||!original.includes(needle))throw new FsError('edit text not found','FS_EDIT_NOT_FOUND');
      if(!edit.replaceAll&&original.indexOf(needle,original.indexOf(needle)+needle.length)>=0)throw new FsError('ambiguous edit','FS_AMBIGUOUS_EDIT');
      const after=edit.replaceAll?original.split(needle).join(replacement):original.replace(needle,()=>replacement);
      const sample=before.Content.slice(0,4096),crlf=(sample.match(/\r\n/gu)??[]).length>(sample.match(/(?<!\r)\n/gu)??[]).length;
      const storage=crlf?after.replaceAll('\n','\r\n'):after;if(storage.includes('\0')||!storage.isWellFormed())throw new FsError('well-formed text without NUL required','FS_NOT_TEXT');if(Buffer.byteLength(storage)>4194304)throw new FsError('scratch text exceeds 4 MiB','FS_TOO_LARGE');
      assertBound(data.binding);checkPolicy(data.binding,policy);
      const result=await current.rpc('write',data.relative,{content:storage,expected:{kind:'replaceIfVersion',version:expected.version}},signal);return{version:FsVersion(result.version),before:original,after};
    });},
    async lstat(value,opts,signal){const absolute=path.resolve(opts?.cwd??actors.getStore()?.agent?.session?.header?.cwd??process.cwd(),value);if(!reserved(value)&&!reserved(absolute))return originals.get('lstat').call(value,opts,signal);return route.stat(await route.resolve(value,{...opts,signal}),signal);},
    processPath(target){return targetData(target)?target.displayPath:originals.get('processPath').call(target);},
    fileUrl(target){return targetData(target)?pathToFileURL(target.displayPath).href:originals.get('fileUrl').call(target);},
    contains(parent,child){const a=targetData(parent),b=targetData(child);if(!a&&!b)return originals.get('contains').call(parent,child);return !!a&&!!b&&a.binding.session===b.binding.session&&inside(parent.displayPath,child.displayPath);},
    processPathFromHostPath(value){if(reserved(value))return undefined;return originals.get('processPathFromHostPath').call?.(value);}
  };
  for(const method of ['readBytes','readByteRange','listDir','watch'])route[method]=function(target,...args){if(targetData(target))throw new FsError('scratch text capability does not expose '+method,'FS_IO_ERROR');return originals.get(method).call(target,...args);};
  const policyCallbacks=new Map();
  observationPolicy({effect:ctx.effect.bind(ctx),on(event,callback){policyCallbacks.set(event,callback);}});
  const canonicalActor=actor=>{
    const current=actors.getStore(),binding=identity(current);
    if(actor?.agent?.id!==binding.agentId||actor?.agent?.session?.id!==binding.sessionId)throw new FsError('scratch observation actor does not match execution','FS_PERMISSION_DENIED');
    return current;
  };
  ctx.on('fs/observed',(target,observation,actor)=>{
    if(!reserved(target.displayPath)&&!reserved(target.targetKey))return;
    const current=canonicalActor(actor);targetData(target);
    policyCallbacks.get('fs/observed')(target,observation,current);
    console.info('[verifier-native-capability] '+JSON.stringify({event:'observed',sessionId:current.agent.session.id,kind:observation.kind,canonicalSessionSame:actor.agent.session===current.agent.session}));
  });
  for(const event of ['fs/write-intent','fs/edit-intent'])ctx.on(event,async(target,actor,next)=>{
    const intent=await next();if(!reserved(target.displayPath)&&!reserved(target.targetKey))return intent;
    const current=canonicalActor(actor);targetData(target);return intent??policyCallbacks.get(event)(target,current);
  },{prepend:true});
  ctx.on('tools/execute',(exec,next)=>actors.run(exec,next),{prepend:true});
  for(const [method,implementation] of Object.entries(route))Object.defineProperty(native,method,{configurable:true,writable:true,value:implementation});
  ctx.effect(()=>async()=>{closing=true;await Promise.allSettled([...initializing]);await Promise.allSettled([...controllers].map(value=>value.close()));for(const [method,original] of originals){if(Object.getOwnPropertyDescriptor(native,method)?.value!==route[method])continue;if(original.descriptor)Object.defineProperty(native,method,original.descriptor);else delete native[method];}});
}
