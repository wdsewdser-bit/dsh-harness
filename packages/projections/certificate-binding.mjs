import { verify } from 'node:crypto';
import { canonical, digest } from '../contracts/index.mjs';
/** Return only committed, internally verifiable binding evidence; no inferred attempt. */
export function certificateBinding(delivery, task, rows) {
 const c=delivery.certificate;
 if(!c || !delivery.certificateHash || digest(c)!==delivery.certificateHash || !c.verifier || delivery.taskId!==task.entityId) return undefined;
 try { if(!verify(null,Buffer.from(canonical(c)),delivery.publicKey,Buffer.from(delivery.signature,'base64')))return undefined; }catch{return undefined;}
 if(c.taskId && c.taskId!==task.entityId)return undefined;
 const binding={certificateHash:delivery.certificateHash,taskId:delivery.taskId,verifier:c.verifier,contractRevision:c.contractRevision,candidate:c.candidate,tree:c.tree,deliveryId:delivery.entityId,deliveryRevision:delivery.revision,status:delivery.status};
 if(c.attemptId){const a=rows.get(c.attemptId);if(a?.taskId!==task.entityId)return undefined;binding.attemptId=c.attemptId;}
 return binding;
}
