import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/** Apply only to an explicitly named prepared copy, never the pristine installation. */
export function installExecutionPermit(build) {
  const file=path.join(build,'node_modules/@deepseek-ai/dsh-llm/lib/index.js');
  let text=fs.readFileSync(file,'utf8');
  const provider=path.join(build,'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js');
  let source=fs.readFileSync(provider,'utf8');
  const direct='onDispatchPhase: (options, phase, extra) => dispatchAttemptOf(options)?.phase(phase, extra)';
  if(!source.includes(direct))throw Error('EXECUTION_PROVIDER_UNCONTROLLED');
  if(!source.includes('executionPermitContract =')) {
    if(!source.includes('dispatchContract = DISPATCH_CONTRACT;'))throw Error('EXECUTION_PROVIDER_MISSING');
    source=source.replace('dispatchContract = DISPATCH_CONTRACT;','dispatchContract = DISPATCH_CONTRACT;\n\texecutionPermitContract = "execution-permit/1";');
    fs.writeFileSync(provider,source);
  }
  const harden=()=>{
    text=text.replaceAll('if(executionCallBeforePrepare && adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)',
      'if(executionCallBeforePrepare && executionCallBeforePrepare.domain!=="host-control" && adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)');
    text=text.replaceAll('if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)',
      'if (attempt.executionCall && attempt.executionCall.domain!=="host-control" && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)');
    text=text.replace('function executionNetwork(work) { const call=executionCalls.getStore(); return call ? call.network(work) : work(); }',
      'function executionNetwork(work) { const call=executionCalls.getStore(); if(!call)throw Object.assign(new Error("EXECUTION_CALL_REQUIRED"),{code:"EXECUTION_CALL_REQUIRED"}); return call.network(work); }');
    if(!text.includes('executionCallBeforePrepare')) {
      const anchor='async *adapterStream(options, prepared) {';
      const begin=text.indexOf(anchor),position=text.indexOf('const adapter = registration.adapter;',begin);
      if(begin<0 || position<begin)throw Error('EXECUTION_PREPARE_ANCHOR');
      const end=position+'const adapter = registration.adapter;'.length;
      text=text.slice(0,end)+'\n\t\t\t\tconst executionCallBeforePrepare=executionCalls.getStore();\n\t\t\t\tif(executionCallBeforePrepare && adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT) {executionCallBeforePrepare.unmanaged();throw new Error("EXECUTION_TRANSPORT_UNCONTROLLED");}'+text.slice(end);
    }
    if(!text.includes('function executionNetwork(')) {
      const anchor='const withExecutionCall = (call,work) => executionCalls.run(call,work);';
      if(!text.includes(anchor))throw Error('EXECUTION_NETWORK_ANCHOR');
      text=text.replace(anchor,anchor+'\nfunction executionNetwork(work) { const call=executionCalls.getStore(); if(!call)throw Object.assign(new Error("EXECUTION_CALL_REQUIRED"),{code:"EXECUTION_CALL_REQUIRED"}); return call.network(work); }\nfunction executionFetch(...args) { return executionNetwork(() => fetch(...args)); }');
      text=text.replace('export { EXECUTION_PERMIT_CONTRACT,','export { executionNetwork, executionFetch, EXECUTION_PERMIT_CONTRACT,');
    }
    if(!source.includes('executionNetwork(() => this.fetchImpl')) {
      source=source.replace('import { APP_IDENTITY,','import { executionFetch, executionNetwork, APP_IDENTITY,');
      source=source.replaceAll('await fetch(', 'await executionFetch(');
      const begin=source.indexOf('response = await this.fetchImpl('),end=source.indexOf('});',begin);
      if(begin<0||end<begin)throw Error('EXECUTION_FILE_NETWORK_ANCHOR');
      source=source.slice(0,begin)+source.slice(begin,end+3).replace('await this.fetchImpl(', 'await executionNetwork(() => this.fetchImpl(').replace(/\}\);$/, '}));')+source.slice(end+3);
      fs.writeFileSync(provider,source);
    }
    if(!text.includes('executionPermitContract = EXECUTION_PERMIT_CONTRACT')) {
      const anchor='return class LlmRuntime extends _classSuper {';
      if(text.split(anchor).length!==2)throw Error('EXECUTION_RUNTIME_ANCHOR');
      text=text.replace(anchor,anchor+'\n\t\texecutionPermitContract = EXECUTION_PERMIT_CONTRACT;');
    }
    text=text.replace('if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT) attempt.executionCall.unmanaged();',
      'if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT) { attempt.executionCall.unmanaged(); throw new Error("EXECUTION_TRANSPORT_UNCONTROLLED"); }');
    text=text.replaceAll('if(executionCallBeforePrepare && adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)',
      'if(executionCallBeforePrepare && executionCallBeforePrepare.domain!=="host-control" && adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)');
    text=text.replaceAll('if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)',
      'if (attempt.executionCall && attempt.executionCall.domain!=="host-control" && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)');
    if(!text.includes('function assertMetadataExecution(')) {
      const helper='function assertMetadataExecution(target) { const call=executionCalls.getStore(); if(call && call.domain!=="host-control" && target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT) { call.unmanaged(); throw Object.assign(new Error("EXECUTION_TRANSPORT_UNCONTROLLED"),{code:"EXECUTION_TRANSPORT_UNCONTROLLED"}); } }\n';
      text=helper+text;
      for(const anchor of ['const models = await this.registration(provider).adapter.listModels(provider);','async resolveModelInfoFor(registration, model, signal) {','async resolveCallFor(registration, config, signal) {','const adapterCall = await registration.adapter.prepareCall(provider, model, signal);','const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);']) {
        if(!text.includes(anchor))throw Error('EXECUTION_METADATA_ANCHOR:'+anchor);
        const target=anchor.startsWith('const models')?'this.registration(provider).adapter':anchor.startsWith('const discovered')?'discover':'registration.adapter';
        text=text.replace(anchor,anchor.startsWith('async ')?anchor+'\nassertMetadataExecution('+target+');':'assertMetadataExecution('+target+');\n'+anchor);
      }
    }
    if(!text.includes('executionIsProxy'))text='import { types as executionTypes } from "node:util";\nconst executionIsProxy=executionTypes.isProxy;\n'+text;
    const trustStart=text.indexOf('const trustedExecutionTargets ='),trustEnd=text.indexOf('function assertMetadataExecution(',trustStart);
    if(trustStart<0){text="const trustedExecutionTargets = new WeakMap();\nfunction executionDescriptors(target) {\n if(!target || !['object','function'].includes(typeof target) || executionIsProxy(target))throw new Error('EXECUTION_TARGET_UNSTABLE');\n const effective=new Map(),chain=[];let object=target;\n while(object && object!==Object.prototype && object!==Function.prototype){\n  if(executionIsProxy(object))throw new Error('EXECUTION_TARGET_UNSTABLE');chain.push(object);\n  for(const key of Reflect.ownKeys(object)){\n   const d=Object.getOwnPropertyDescriptor(object,key);if(!d || 'get' in d || 'set' in d)throw new Error('EXECUTION_TARGET_ACCESSOR');\n   if(!effective.has(key))effective.set(key,{owner:object,...d});\n  }\n  object=Object.getPrototypeOf(object);\n }\n return {effective,chain};\n}\nfunction registerExecutionTarget(target) {\n const {effective}=executionDescriptors(target);\n // Pin each effective method as a non-shadowable data property on this exact instance.\n for(const [key,d] of effective)if(typeof d.value==='function' && key!=='constructor')Object.defineProperty(target,key,{value:d.value,writable:false,configurable:false,enumerable:d.enumerable});\n Object.preventExtensions(target);\n const snapshot=executionDescriptors(target);trustedExecutionTargets.set(target,snapshot);return target;\n}\nfunction isExecutionTargetTrusted(target) {\n try{const prior=target&&trustedExecutionTargets.get(target);if(!prior || Object.isExtensible(target))return false;\n const current=executionDescriptors(target);if(current.chain.length!==prior.chain.length||current.chain.some((x,i)=>x!==prior.chain[i])||current.effective.size!==prior.effective.size)return false;\n for(const [key,d]of prior.effective){const now=current.effective.get(key);if(!now||d.owner!==now.owner||d.configurable!==now.configurable||d.enumerable!==now.enumerable||(typeof d.value==='function')!==(typeof now.value==='function'))return false;\n  if(typeof d.value==='function'&&(now.value!==d.value||now.writable!==false||now.configurable!==false||now.owner!==target)&&key!=='constructor')return false;\n }\n return true;\n }catch{return false;}\n}\n"+text;text=text.replace('export { executionNetwork,','export { registerExecutionTarget, isExecutionTargetTrusted, executionNetwork,');}
    else {if(trustEnd<trustStart)throw Error('EXECUTION_TRUST_ANCHOR');text=text.slice(0,trustStart)+"const trustedExecutionTargets = new WeakMap();\nfunction executionDescriptors(target) {\n if(!target || !['object','function'].includes(typeof target) || executionIsProxy(target))throw new Error('EXECUTION_TARGET_UNSTABLE');\n const effective=new Map(),chain=[];let object=target;\n while(object && object!==Object.prototype && object!==Function.prototype){\n  if(executionIsProxy(object))throw new Error('EXECUTION_TARGET_UNSTABLE');chain.push(object);\n  for(const key of Reflect.ownKeys(object)){\n   const d=Object.getOwnPropertyDescriptor(object,key);if(!d || 'get' in d || 'set' in d)throw new Error('EXECUTION_TARGET_ACCESSOR');\n   if(!effective.has(key))effective.set(key,{owner:object,...d});\n  }\n  object=Object.getPrototypeOf(object);\n }\n return {effective,chain};\n}\nfunction registerExecutionTarget(target) {\n const {effective}=executionDescriptors(target);\n // Pin each effective method as a non-shadowable data property on this exact instance.\n for(const [key,d] of effective)if(typeof d.value==='function' && key!=='constructor')Object.defineProperty(target,key,{value:d.value,writable:false,configurable:false,enumerable:d.enumerable});\n Object.preventExtensions(target);\n const snapshot=executionDescriptors(target);trustedExecutionTargets.set(target,snapshot);return target;\n}\nfunction isExecutionTargetTrusted(target) {\n try{const prior=target&&trustedExecutionTargets.get(target);if(!prior || Object.isExtensible(target))return false;\n const current=executionDescriptors(target);if(current.chain.length!==prior.chain.length||current.chain.some((x,i)=>x!==prior.chain[i])||current.effective.size!==prior.effective.size)return false;\n for(const [key,d]of prior.effective){const now=current.effective.get(key);if(!now||d.owner!==now.owner||d.configurable!==now.configurable||d.enumerable!==now.enumerable||(typeof d.value==='function')!==(typeof now.value==='function'))return false;\n  if(typeof d.value==='function'&&(now.value!==d.value||now.writable!==false||now.configurable!==false||now.owner!==target)&&key!=='constructor')return false;\n }\n return true;\n }catch{return false;}\n}\n"+text.slice(trustEnd);}
    text=text.replaceAll('target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT','target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT');
    if(!text.includes('!isExecutionTargetTrusted(target)'))text=text.replaceAll('target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT','(!isExecutionTargetTrusted(target) || target?.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)');
    if(!text.includes('!isExecutionTargetTrusted(adapter)'))text=text.replaceAll('adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT)','(!isExecutionTargetTrusted(adapter) || adapter.executionPermitContract!==EXECUTION_PERMIT_CONTRACT))');
    if(!text.includes('!isExecutionTargetTrusted(adapter) || adapter.executionPermitContract !=='))text=text.replaceAll('adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT)','(!isExecutionTargetTrusted(adapter) || adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT))');
    fs.writeFileSync(file,text);
  };
  if(text.includes('EXECUTION_PERMIT_CONTRACT')) {
    if(!text.includes('executionCall.unmanaged')) {
      text=text.replace('const sessionId = request.sessionId;',
        'if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT) attempt.executionCall.unmanaged();\n\tconst sessionId = request.sessionId;');
      fs.writeFileSync(file,text);
    }
    harden();return;
  }
  const replace=(old,value)=>{
    if(text.split(old).length!==2)throw Error('EXECUTION_PATCH_ANCHOR:'+old.slice(0,80));
    text=text.replace(old,value);
  };
  text='import { AsyncLocalStorage as ExecutionCallStorage } from "node:async_hooks";\n'+text;
  replace('const dispatchAttempts =',
    'const EXECUTION_PERMIT_CONTRACT = "execution-permit/1";\n'+
    'const executionCalls = new ExecutionCallStorage();\n'+
    'const withExecutionCall = (call,work) => executionCalls.run(call,work);\n'+
    'const dispatchAttempts =');
  replace('sendStartedCount: 0,','sendStartedCount: 0,\n\t\texecutionCall: executionCalls.getStore() ?? null,\n\t\texecutionTokens: [],');
  replace('this.sendStartedCount++;',
    'if (this.executionCall) this.executionTokens.push(this.executionCall.reserve(this.id,transmission));\n\t\t\t\tthis.sendStartedCount++;');
  replace('if (item.done) {',
    'if (item.done) {\n\t\t\t\t\t\tfor (const token of attempt?.executionTokens ?? []) attempt.executionCall.finish(token,"executed");');
  replace('const close = iterator.return?.bind(iterator);',
    'const close = iterator.return?.bind(iterator);');
  // No committed/header event settles X. Exceptions/early return retain X until independent reconciliation.
  replace('export { ACCOUNT_QUOTA_EXCEEDED_CODE,',
    'export { EXECUTION_PERMIT_CONTRACT, withExecutionCall, ACCOUNT_QUOTA_EXCEEDED_CODE,');
  text=text.replace('const sessionId = request.sessionId;',
    'if (attempt.executionCall && adapter.executionPermitContract !== EXECUTION_PERMIT_CONTRACT) attempt.executionCall.unmanaged();\n\tconst sessionId = request.sessionId;');
  harden();
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const build=process.argv[2];if(!build || !path.resolve(build).includes(path.sep+'runs'+path.sep))throw Error('PREPARED_COPY_REQUIRED');
  installExecutionPermit(build);
}
