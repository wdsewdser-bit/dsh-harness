import fs from 'node:fs';
import net from 'node:net';
import {bootProfile} from '../../packages/profiles/index.mjs';
import {wire,digest} from './protocol.mjs';
const [root,actor,sessionId]=process.argv.slice(2);
delete process.env.CLOSEOUT_PROVIDER_KEY;
net.Socket.prototype.connect=function(){throw Error('COLD_NETWORK_DENIED')};
globalThis.fetch=async()=>{throw Error('COLD_NETWORK_DENIED')};
const scratch=root+'/cold-reader-'+actor;
fs.mkdirSync(scratch,{recursive:true});
fs.cpSync(root+'/host/sessions',scratch+'/sessions',{recursive:true});
const {ctx}=await bootProfile(scratch,{team:false,guard:false,goalCheck:false});
try{
  // F2b: the session id is the one the product opened for the member (its intent's effect), not a harness name.
  const handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'offline',model:'model'}});
  const messages=handle.agent.session.deriveMessages(),raw=JSON.parse(fs.readFileSync(root+'/opaque-responses.json'));
  const report={pid:process.pid,messagesHash:digest(messages),wireHash:digest(wire(messages,raw)),providerRequests:0,
    source:'fresh process, byte-copy of flushed native persistence and exact opaque sidecar'};
  fs.writeFileSync(root+'/cold-reader-report.json',JSON.stringify(report,null,2));
  await handle.dispose();
}finally{await ctx.fiber.dispose();}
