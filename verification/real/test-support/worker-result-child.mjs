// Data-only integration child. Replays facts through the exact production worker verdict/report/exit path.
// Synthetic live labels exercise qualification logic; this never contacts a provider or claims a live benchmark.
import fs from 'node:fs';import net from 'node:net';
import {evaluateWorkerResult,writeWorkerReport} from '../worker-result.mjs';
import {scopedRoot} from '../scope.mjs';
const [input,output]=process.argv.slice(2),root=scopedRoot(output);
if(fs.existsSync(root))throw Error('OUTPUT_MUST_BE_NEW');
net.Socket.prototype.connect=function(){throw Error('OFFLINE_NETWORK_DENIED');};
globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_DENIED');};
const facts=JSON.parse(fs.readFileSync(input,'utf8'));
const {metrics,status,error}=evaluateWorkerResult(facts,'evaluated');
fs.mkdirSync(root,{recursive:true});
process.exitCode=writeWorkerReport(root,{stage:facts.stage,status,error,metrics,
 reportEvaluationOnly:true,syntheticPerformanceStudy:true,realProviderRequests:0});
