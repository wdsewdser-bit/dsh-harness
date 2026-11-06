import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {handleTool} from '../../packages/core/tools.mjs';
import {noteCheckpoint} from './timing.mjs';
import {issueView,reviewGuard,reviewDelivery,integrateGuard} from '../../packages/core/workload.mjs';
export const git=(root,...args)=>new Promise((resolve,reject)=>execFile('git',['-C',root,...args],{encoding:'utf8',windowsHide:true},(error,stdout,
      stderr)=>error?reject(Error('GIT_FIXTURE:'+stderr)):resolve(stdout.trim())));
export async function repository(root){fs.mkdirSync(root,{recursive:true});await git(root,'init','-b','parking');await git(root,'config','user.name',
    'Offline fixture');await git(root,'config','user.email','offline@example.invalid');await git(root,'commit','--allow-empty','-m','initial');await git(root,
    'branch','accepted');return root;
  }
export function productTool(e,actor,name,args){const s=e.states.get(actor);return e.runtime.host.executeAuthorized('business',()=>handleTool(e.core,{
        actor:'member:'+actor,...s.binding},name,{operationId:'v1:operation:'+randomUUID(),...args}));
  }
const timeOf=(e,id,status)=>e.core.store.events().find(x=>x.entity===id&&x.payload.status===status)?.payload.updatedAt;
/**
 * The fail-closed half of review: a product delivery readback may legitimately return unknown (dirty/head/verifier).
 * Record the raw status/code/reason, mark the delivery unknown, and return an explicit non-success result. Only a row
 * that is actually verified with a certificate may continue to the signed-certificate/reply path.
 */
export function recordDeliveryVerification(delivery, verified, facts) {
  const status = verified?.status ?? 'unknown';
  const code = verified?.code ?? verified?.lastEvidence?.code ?? null;
  const reason = verified?.reason ?? null;
  const lastEvidence = verified?.lastEvidence ?? null;
  (facts.verificationResults ??= []).push({ deliveryId: delivery.id, status, code, reason, lastEvidence });
  if (status !== 'verified' || !verified?.certificate) {
    Object.assign(delivery, { status: 'unknown', verificationFailure: true, failureReason: reason, lastEvidence });
    return { id: delivery.id, status: 'unknown', code, reason, lastEvidence, certificate: null };
  }
  return null;
}

/** The single decision point between a certified delivery and the reply/integration path. */
export function applyDeliveryVerification({ delivery, verified, facts, onVerified = null }) {
  const failure = recordDeliveryVerification(delivery, verified, facts);
  if (failure) return { failed: true, result: failure };
  if (onVerified) onVerified();
  return { failed: false };
}

export async function executeProductWork(e,actor,args){const s=e.states.get(actor),c=e.cycle;
 if(args.op==='open'){
  if(!c.issue){const out=productTool(e,actor,'team_thread',{op:'open',owner:'member:root',requiredRespondents:['member:verifier'],requiredEvidence:Object.keys(c
          .assignments).map(a=>'artifact:'+c.id+':'+a),question:'Review batch '+c.id,deadline:e.fault==='omit-accept'?'PT1S':'PT5M',taskRef:e.states.get(
            'a1').task});
          c
    .issue=out.result.entityId;c.issueAt=e.core.store.read(c.issue).createdAt;
    }
  return issueView(e.core,c);
 }
 if(args.op==='produce'){
  const a=c.assignments[actor],m=e.core.store.read(args.messageId);
  if(!m?.accepted||!m.visible||m.recipient!=='member:'+actor||m.sender!=='member:'+a.from||!m.observation?.manifestHash)throw Error('DEPENDENCY_NOT_RELEASED');
  const peer=JSON.parse(m.summary);if(peer.cycle!==c.id||peer.value!==c.assignments[a.from].own||args.value!==a.own+peer.value)throw Error('QUALITY_FAILED');
  if(c.deliveries.some(d=>d.actor===actor))throw Error('DUPLICATE_DELIVERY');
  // Serial publication follows arrival at the product producer. The predecessor is read from actual produced events,
  // not from member order. Candidates are signed only after rebuilding on this predecessor.
  const previous=e.publication??Promise.resolve();let release;e.publication=new Promise(r=>release=r);await previous;
  try{
   const published=e.core.store.events().filter(x=>x.entity.startsWith('delivery:')&&x.payload.status==='produced').at(-1);
   const predecessor=published?.payload.candidate??await git(e.repository,'rev-parse','refs/heads/accepted');
   await git(e.repository,'reset','--hard',predecessor);
   const work=await e.runtime.delivery.worktree(s.task,'member:'+actor);
   const artifact='artifact:'+c.id+':'+actor,file=path.join(work.directory,actor+'.json');
   fs.writeFileSync(file,JSON.stringify({cycle:c.id,actor,value:args.value,messageId:args.messageId,manifestHash:m.observation.manifestHash}));
   await git(work.directory,'add',actor+'.json');await git(work.directory,'commit','-m','publish '+artifact);
   const produced=await e.runtime.delivery.produce(s.task);
   productTool(e,actor,'team_message',{op:'resolve',messageId:m.entityId,resultRef:artifact,expectedRevision:e.core.store.read(m.entityId).revision});
   productTool(e,actor,'team_task',{op:'produce',taskRef:s.task,deliveryRef:produced.entityId});
   const d={id:artifact,deliveryId:produced.entityId,actor,file,cycle:c.id,task:s.task,value:args.value,status:produced.status,producedAt:timeOf(e,produced
       .entityId,'produced'),expected:a.own+peer.value,contractRevision:1,sourceRequestId:s.requestId,messageId:args.messageId,
       manifestHash:m.observation.manifestHash,
     candidate:produced.candidate,tree:produced.tree,base:produced.base};
   c.deliveries.push(d);e.facts.deliveries.push(d);noteCheckpoint(e,actor,c.id,s.binding?.attemptId,d.producedAt);e.progress('produce:'+actor);return {
     id:artifact,status:d.status,value:args.value};
  }finally{release();}
 }
 if(args.op==='review'){
  const d=reviewDelivery(c,args,actor);
  const refused=reviewGuard(c);if(refused){s.refused=true;throw Error(refused);}
  // Independent product verifier reads the rebuilt candidate's committed blobs. Arithmetic is also checked against
  // the immutable assignment, never accepted from the model's approval boolean.
  const raw=JSON.parse(await git(path.dirname(d.file),'show','HEAD:'+path.basename(d.file)));
  if(raw.value!==d.expected||raw.actor!==d.actor||raw.cycle!==c.id)throw Error('INDEPENDENT_READBACK_FAILED');
  productTool(e,actor,'team_verify',{deliveryRef:d.id,contractRevision:1,verdict:'pass',evidenceRefs:[d.id],
      reason:'independent arithmetic and committed candidate readback'});
  const verified=await e.runtime.delivery.verify(d.task,'member:verifier',d.id);
  const outcome=applyDeliveryVerification({delivery:d,verified,facts:e.facts,onVerified:()=>{
   Object.assign(d,{status:verified.status,verifiedAt:timeOf(e,d.deliveryId,'verified'),certificate:verified.certificate,signature:verified.signature,
       publicKey:verified.publicKey,certificateHash:verified.certificateHash,verifierRequestId:s.requestId});
   productTool(e,actor,'team_thread',{op:'reply',issueId:c.issue,expectedRevision:e.core.store.read(c.issue).revision,proposalRevision:1,bodyRef:d.id});
  }});
  if(outcome.failed)return outcome.result;
  e.progress('verify:'+d.actor);return {id:d.id,status:d.status,certificate:d.certificate,issue:issueView(e.core,c)};
 }
 if(args.op==='integrate'){
  const t=issueView(e.core,c),refused=integrateGuard(c,t);if(refused){s.refused=refused!=='DELIVERIES_NOT_VERIFIED';throw Error(refused);}
  if(t.status==='collecting')productTool(e,actor,'team_thread',{op:'decide',issueId:c.issue,expectedRevision:e.core.store.read(c.issue).revision,
      proposalRevision:1,conclusionRef:c.deliveries[0].id});
  // Product publication events define the queue; acceptance is never ordered by an actor list.
  const ordered=e.core.store.events().filter(x=>x.entity.startsWith('delivery:')&&x.payload.status==='produced').map(x=>c.deliveries.find(d=>d.deliveryId===x
      .entity)).filter(Boolean);
  for(const d of ordered){const accepted=await e.runtime.delivery.integrate(d.task,'refs/heads/accepted');Object.assign(d,{status:accepted.status,
        mergedAt:timeOf(e,d.deliveryId,'applying'),acceptedAt:timeOf(e,d.deliveryId,'accepted'),integrationCommit:accepted.integrationCommit,integrationTree:
        accepted
        .integrationTree});}
  const row=e.core.store.read(c.issue),manifest=e.core.store.list('manifest:').findLast(m=>m.memberId==='member:root');
  e.facts.decisions.push({issueId:c.issue,issueAt:c.issueAt,decisionAt:row.updatedAt,latencyMs:row.updatedAt-c.issueAt,requestId:s.requestId,
      manifestHash:manifest?.hash,verifierRequestId:c.deliveries.at(-1).verifierRequestId,status:row.status,deadline:row.deadline});e.progress('integrate');
        return {
    status:'accepted',count:c.deliveries.length};
 }
 throw Error('UNKNOWN_WORK_OPERATION');
}