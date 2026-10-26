import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const stage=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
// Explicit isolated opt-in; apply this to the selected profile's patch array.
// This helper never reads credentials, copies production config, or starts a host.
export function verifierNativeProfilePatch(source,{enabled=false,isolatedHost=false,pluginPath=path.join(stage,'home/profiles/web/plugins/verifier-native-capability.mjs')}={}) {
  if(!Array.isArray(source))throw new Error('INVALID_PROFILE_PATCH');
  if(!enabled)return structuredClone(source);
  if(isolatedHost!==true)throw new Error('ISOLATED_HOST_OPT_IN_REQUIRED');
  if(source.some(row=>row?.insert?.some(plugin=>plugin.id==='verifier-native-capability')))throw new Error('DUPLICATE_VERIFIER_NATIVE_CAPABILITY');
  return [...structuredClone(source),
    {id:'write-scope-guard',config:{verifierScratchMode:'session-workspace'}},
    {insert:[{id:'verifier-native-capability',name:pathToFileURL(path.resolve(pluginPath)).href,config:{enabled:true,isolatedHost:true}}]},
  ];
}
