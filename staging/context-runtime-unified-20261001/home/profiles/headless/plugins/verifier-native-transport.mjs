import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FsError } from '../../../../app/node_modules/@deepseek-ai/dsh-fs/lib/index.js';

const directory=path.dirname(fileURLToPath(import.meta.url));
export async function openHandleBridge(root,{bootstrap,authorizeBootstrap,onDispatchForFixture,beforeSpawnForFixture,bridgeScriptForFixture}={}) {
  const expectedFileId=bootstrap?null:fs.statSync(root,{bigint:true}).ino.toString();
  let sessionRootFileId;
  if(bootstrap){try{sessionRootFileId=fs.lstatSync(root,{bigint:true}).ino.toString();}catch(error){if(error.code!=='ENOENT')throw error;}}
  beforeSpawnForFixture?.();
  let state='starting',bootstrapAuthorized=false,sequence=0,stderr='',readyResolve,readyReject,tail=Promise.resolve();
  const pending=new Map();
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const args=bootstrap?['-Workspace',bootstrap.workspace,'-WorkspaceExpectedFileId',bootstrap.workspaceFileId,'-SessionId',bootstrap.sessionId]:['-ControllerDerivedRoot',root,'-ControllerExpectedFileId',expectedFileId];
  if(sessionRootFileId)args.push('-SessionRootExpectedFileId',sessionRootFileId);
  const child=spawn('pwsh',['-NoProfile','-File',bridgeScriptForFixture??path.join(directory,'verifier-native-host-bridge.ps1'),...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  function fail(error) {
    if(state==='failed'||state==='closed')return;
    state='failed';readyReject(error);
    for(const request of pending.values())request.reject(error);pending.clear();
    lines.close();child.stdin.destroy();child.kill();
  }
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
  child.stdin.on('error',error=>fail(new FsError('scratch transport input failed','FS_IO_ERROR',{cause:error})));
  child.once('error',error=>fail(new FsError('scratch helper launch failed','FS_IO_ERROR',{cause:error})));
  const closed=new Promise(resolve=>child.once('close',code=>{
    if(state!=='closing'&&state!=='failed')fail(new FsError('scratch helper exited before completion: '+stderr,'FS_IO_ERROR'));
    if(state!=='failed')state='closed';lines.close();resolve(code);
  }));
  lines.on('line',line=>{
    try {
      const result=JSON.parse(line);
      if(state==='starting') {
        if(result.bootstrapReady===true){
          if(!bootstrap||bootstrapAuthorized||result.scope!=='workspace-handle-pinned-before-creation')throw new Error('unexpected bootstrap challenge');
          authorizeBootstrap?.();bootstrapAuthorized=true;
          child.stdin.write(JSON.stringify({op:'authorize-bootstrap'})+'\n');return;
        }
        if(bootstrap&&!bootstrapAuthorized)throw new Error('missing bootstrap authorization challenge');
        if(result.ready!==true||result.scope!=='controller-derived-root-handle-identity-checked'||result.filesystem!=='NTFS')throw new Error('invalid scratch helper handshake');
        state='ready';readyResolve(result);return;
      }
      if(state!=='ready'&&state!=='closing')return;
      const request=pending.get(result.id);
      if(!request||typeof result.ok!=='boolean')throw new Error('unexpected scratch helper response');
      if(!result.ok&&!(result.error&&typeof result.error.code==='string'&&typeof result.error.message==='string'))throw new Error('malformed scratch helper error');
      pending.delete(result.id);
      if(result.ok)request.resolve(result.value);
      else if(result.error&&typeof result.error.code==='string'&&typeof result.error.message==='string')request.reject(new FsError(result.error.message,result.error.code==='FS_UNSUPPORTED_METADATA'?'FS_IO_ERROR':result.error.code));
    }catch(error){fail(new FsError('scratch helper protocol failure','FS_IO_ERROR',{cause:error}));}
  });
  let hello;
  try{hello=await ready;}catch(error){await closed;throw error;}
  function dispatch(op,relative,extra,signal) {
    if(state!=='ready')throw new FsError('scratch transport unavailable','FS_IO_ERROR');
    if(signal?.aborted)throw new FsError('scratch operation aborted','FS_ABORTED');
    const id=++sequence;
    const cancel=()=>{if(state==='ready')child.stdin.write(JSON.stringify({op:'cancel',cancelId:id})+'\n');};
    signal?.addEventListener('abort',cancel,{once:true});
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      child.stdin.write(JSON.stringify({id,op,relative,...extra})+'\n',error=>{if(error)fail(new FsError('scratch request dispatch failed','FS_IO_ERROR',{cause:error}));});
      onDispatchForFixture?.({id,op,relative});
    }).finally(()=>signal?.removeEventListener('abort',cancel));
  }
  return {
    hello,expectedFileId,
    rpc(op,relative,extra={},signal){const run=tail.then(()=>dispatch(op,relative,extra,signal));tail=run.catch(()=>{});return run;},
    async close(){await tail;try{if(state==='ready')await dispatch('close','',{});}finally{if(state!=='failed')state='closing';child.stdin.end();await closed;lines.close();}},
    get state(){return state;},get stderr(){return stderr;}
  };
}
