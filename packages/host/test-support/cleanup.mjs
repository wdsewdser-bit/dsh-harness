import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const errorInfo=e=>e?{name:e.name,message:e.message,code:e.code,stack:e.stack}:null;
export async function closeRealFixture({root,host,store,error=null,expectIsolated=false,remove=p=>fs.rmSync(p,{recursive:true,force:true}),wait=ms=>new Promise(
  r=>setTimeout(r,ms))}){
 let stopResult=null,cleanupError=null,attempts=0;
 try{stopResult=await host.stop();}catch(e){cleanupError=e;}
 try{store.close();}catch(e){cleanupError??=e;}
 const confirmed=stopResult?.state==='stopped' && stopResult.timedOut===false && stopResult.isolated===false &&
  ['closed','none'].includes(stopResult.store)&&['released','none'].includes(stopResult.ownership);
 if(!cleanupError&&!confirmed&&expectIsolated&&stopResult?.state==='stopped'&&stopResult?.isolated===true&&stopResult?.timedOut===true){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-fixture-isolated-')),file=path.join(directory,'stop.json'),result={root,stopResult,attempts:0,
    removed:false,expectedIsolation:true,originalError:errorInfo(error)};fs.writeFileSync(file,JSON.stringify(result,null,2));return {...result,diagnostics:
    file};
 }
 if(!cleanupError&&!confirmed)cleanupError=Object.assign(Error('host stop did not confirm resource closure'),{code:'FIXTURE_STOP_UNCONFIRMED'});
 if(!cleanupError){for(const delay of [0,20,50,100,200]){if(delay)await wait(delay);attempts++;try{remove(root);break;}catch(e){if(!['EPERM','EBUSY',
   'ENOTEMPTY'].includes(e.code)||attempts===5){cleanupError=e;break;}}}}
 if(!cleanupError)return {root,stopResult,attempts,removed:true};
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-fixture-cleanup-')),file=path.join(directory,'failure.json');
 const result={root,stopResult,attempts,removed:false,originalError:errorInfo(error),cleanupError:errorInfo(cleanupError)};
 fs.writeFileSync(file,JSON.stringify(result,null,2));console.error('FIXTURE_CLEANUP_FAILED '+JSON.stringify({...result,diagnostics:file}));
 if(error){error.cleanupDiagnostics=file;return {...result,diagnostics:file};}
 throw Object.assign(Error('fixture cleanup failed; retained='+root+'; diagnostics='+file,{cause:cleanupError}),{code:'FIXTURE_CLEANUP_FAILED',diagnostics:
   file,stopResult});
}
