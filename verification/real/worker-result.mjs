import fs from 'node:fs';
import {summarize} from './metrics.mjs';

/** One production verdict for the worker and data-only regression replays. Cleanup/status errors still win. */
export function evaluateWorkerResult(facts,status,error=null){
 const metrics=summarize(facts);
 if(status==='evaluated')status=metrics.passed?'passed':'assertions-failed';
 if(metrics.toolOutputErrors.length){
  error={code:'TOOL_OUTPUT_ERROR',message:'工具输出错误',details:metrics.toolOutputErrors,prior:error};status='failed';
 }
 return {metrics,status,error};
}

/** Shared report/exit path: a failing metric must survive serialization and fail the process. */
export function writeWorkerReport(root,report,{key=null}={}){
 fs.writeFileSync(root+'/report.json',JSON.stringify(report,(_,v)=>typeof v==='string'&&key?v.split(key).join('[REDACTED]'):v,2));
 return ['passed','dry-run-passed'].includes(report.status)?0:2;
}
