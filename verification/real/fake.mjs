import {digest,checkPairs} from './protocol.mjs';import {randomUUID} from 'node:crypto';import {route} from './config.mjs';
export function fakeProvider(engine,{fault=null}={}){let serial=0;return async(body,meta)=>{checkPairs(body.input);for(const tool of body.tools??[])if(tool
      .parameters?.type!=='object')throw Error('FAKE_REJECTS_NON_OBJECT_TOOL_SCHEMA');const seq=++serial,base={id:'fake-response-'+seq,usage:{input_tokens:Math
        .ceil(JSON.stringify(body).length/4),output_tokens:40,input_tokens_details:{cached_tokens:meta.purpose==='replay'?100:0},cost:0}};for(
        const item of body.input
      .filter(x=>x.type==='reasoning'))if(item.encrypted_content!=='fake-signed:'+digest(item.id))return{...base,error:{code:'invalid_reasoning',
        message:'fake signature mismatch'},output:[]};if(fault==='reject-reasoning'&&body.input.some(x=>x.type==='reasoning'))return{...base,error:{
        code:'injected_signature_rejection',message:'offline raw rejection'},output:[]};
 const shownText=body.input.flatMap(x=>x.content??[]).map(x=>x.text??'').filter(x=>x.startsWith('<team_snapshot ')).at(-1)??'';const shown=m=>shownText
 .includes(JSON.stringify(m.entityId));
 // Instruction authority comes from the actual request, not the pending store or unrelated marker text.
 const snapshots=body.input.flatMap(x=>x.content??[]).map(x=>x.text??'').filter(x=>x.startsWith('<team_snapshot ')).flatMap(text=>{
   try{return [JSON.parse(text.slice(text.indexOf('\n')+1,text.lastIndexOf('\n')))];}catch{return []}
 });
 const instructedBy=(m,cycle)=>String(m.summary??'').includes('Cross-peer task cycle '+cycle)&&snapshots.some(p=>
   p.self?.memberId==='member:'+meta.actor&&p.responsibilities?.some(r=>r.messageId===m.entityId&&r.from==='member:root'&&r.kind==='action')&&
   p.memberData?.some(d=>d.messageId===m.entityId));
 const state=engine.states.get(meta.actor);let call=null,batch=null;if(meta.purpose==='replay'||meta.purpose==='cold-probe'){}
 // The loop fault is placed before every other branch: any member asked by the run repeats one identical call, so the
 // dead-loop detector has something real to stop. It is a plain team_read, which the server accepts and which advances
 // nothing: exactly the shape a model produces when it re-reads a view hoping for a different answer.
 else if(state&&fault==='turn-request-limit'){call=['team_read',{view:'team',limit:1+seq%20}]}
  else if(state&&fault==='repeat-tool-call'){call=['team_read',{view:'team'}]}else if(meta.actor==='root'&&engine.compatibilityMode){if(!state.compatHanded){
     state.compatHanded=true;call=['team_message',{operationId:'v1:operation:'+randomUUID(),expectedRevision:0,op:'send',to:'member:a1',kind:'action',
         summary:'Checkpoint this responsibility for root',expectedOutcome:'accept it, then answer the interface marker',deadline:'PT5M'}]}else if(
           !state.probed){
         state
     .probed=true;call=['real_work',{op:'brief'}]}
   }
 else if(engine.stage==='performance'&&state&&meta.actor!=='root'&&!state.studyBrief){state.studyBrief=true;call=['real_work',{op:'brief'}]}
 else if(engine.compatibilityMode&&meta.actor==='a1'){const visible=()=>engine.core.pending('member:a1').find(m=>shown(m)&&m.recipient==='member:'+meta.actor&&m
     .kind==='action'&&m.visible&&!m.accepted&&m.sender==='member:root');let incoming=visible();
  // The visibility port commits the responsibility after the request that carried it, so a later step of the same turn
  // may have to give it a moment; that is the scripted model re-reading its own mailbox, not a change to the host.
  if(!incoming&&engine.smokeSent){const end=Date.now()+3000;while(!incoming&&Date.now()<end){await new Promise(resolve=>setTimeout(resolve,25));incoming
      =visible()}}
  // The invalid-tool-output fault has to land in the member's own history: the off-mode replay probes of a1 are what
  // the output-contract assertion judges, and a defect recorded only in root's session would leave them unattributed.
  if(fault==='invalid-tool-output'&&!state.briefed){state.briefed=true;call=['real_work',{op:'brief'}]}
  else if(incoming&&!state.compatAccepted){state.compatAccepted=true;
   // This controlled receiver answers before the transport publishes committed. The current request's committed
   // visibility write increments the durable revision before tools run; account for that one known write only when
   // this request's manifest actually contains the message (the fixture exercises CAS, it does not bypass it).
   // The manifest is persisted only after committed. Use the latest snapshot actually in this request rather than an
   // older snapshot in its history or a not-yet-written manifest row.
   const snapshots=body.input.flatMap(item=>item.content??[]).filter(block=>typeof block.text==='string'&&block.text.startsWith('<team_snapshot '));
   const pendingVisibility=(snapshots.at(-1)?.text??'').includes(JSON.stringify(incoming.entityId))?1:0;
   call=['team_message',{operationId:'v1:operation:'+randomUUID(),expectedRevision:(incoming.revision??0)+pendingVisibility,op:'accept',messageId:incoming
       .entityId,checkpointRef:'checkpoint:compat'}]}else if(!engine.smokeSent){engine.smokeSent=true;call=['team_message',{operationId:'v1:operation:'+
         randomUUID(),
         expectedRevision:0,op:'send',to:'member:root',kind:'action',summary:'ALPHA7 interface evidence',expectedOutcome:'persist accepted checkpoint',deadline:
           'PT5M'
         }]
           }
     }
 else if(state&&state.refused){/* the guard already answered; the turn stops and the ordering is repaired. */}
  // The loop fault: the member repeats one identical call, so the dead-loop detector has something real to stop. The
  // call is a plain team_read, which the server accepts and which never advances anything: exactly the shape a model
  // produces when it re-reads a view hoping for a different answer.
  else if(state&&fault==='repeat-tool-call'){call=['team_read',{view:'team'}]}
  else if(state&&meta.actor!=='root'&&state.binding&&engine.core.store.read(state.binding.attemptId)?.lease!=='active'){}
   else if(state&&engine.cycle&&meta.actor!=='root'&&fault!=='omit-accept'&&engine.core.pending('member:'+meta.actor).some(m=>shown(m)&&m.recipient==='member:'
       +meta.actor&&m.kind==='action'&&m.visible&&!m.accepted)){const m=engine.core.pending('member:'+meta.actor).find(m=>shown(m)&&m.recipient==='member:'
       +meta.actor
       &&m.kind==='action'&&m.visible&&!m.accepted);call=['real_work',{op:'accept',messageId:m.entityId}]
     }
   else if(state&&engine.cycle){const c=engine.cycle;if(meta.actor==='root'){
   // The review-before-open fault replays the real ordering failure: root integrates before opening the review
   // issue (and sends no arguments), so the verifier completes the batch with no thread to reply on.
   if(fault==='review-before-open'){
     // Replays the real ordering failure: root never opens the review issue at cycle start (turn 1), then tries to
     // integrate first (turn 2). The guards refuse both out-of-order steps, and the turn after that repairs the
     // ordering by opening the issue, exactly as the real model would have to.
     engine.faultRootTurns=(engine.faultRootTurns??0)+1;
     if(engine.faultRootTurns===2&&!c.issue)call=['real_work',{op:'integrate'}];
     else if(engine.faultRootTurns>2&&!c.issue)call=['real_work',{op:'open'}];
     else if(c.issue&&c.deliveries.length===4&&c.deliveries.every(d=>d.status==='verified'))call=['real_work',{op:'integrate'}]}
    // Integration follows the thread's own readiness, exactly what the model reads from team_read/ brief.
   else if(!c.issue)call=['real_work',{op:'open'}];
   else if(c.deliveries.length===4&&c.deliveries.every(d=>d.status==='verified'))call=['real_work',{op:'integrate'}]}
 else if(meta.actor==='verifier'){
    // Model the batching instruction, NOT less work: all four real reviews/readbacks/signatures/replies still execute.
    batch=c.deliveries.filter(d=>d.status==='produced').map((d,index)=>['real_work',{op:'review',deliveryId:index%2?d.id:d.deliveryId,approved:true}]);
  }
 // A member only obeys an instruction it was actually handed: the cycle instruction reaches a worker as a durable
  // responsibility from member:root, so a run that never sends one leaves every worker with an empty mailbox and no
  // delivery to make. Scripting the obedience without the instruction is what let a live soak fail while this passed.
  else{const instructed=engine.core.pending('member:'+meta.actor).some(m=>m.sender==='member:root'&&m.kind==='action'&&
      instructedBy(m,c.id));if(!instructed){}
 else if(!c.sent.has(meta.actor)){const local=c.assignments[meta.actor];call=['team_message',{operationId:'v1:operation:'+randomUUID(),expectedRevision:0,
         op:'send',to:'member:'+local.to,kind:'action',summary:JSON.stringify({cycle:c.id,value:local.own}),expectedOutcome:'use interface and deliver result',
         deadline:fault==='omit-accept'?'PT1S':'PT5M'}]
     }
 else{const m=engine.core.pending('member:'+meta.actor).find(m=>shown(m)&&m.recipient==='member:'+meta.actor&&m.kind==='action'&&!m.accepted);if(m
     &&fault!=='omit-accept')call=['real_work',{op:'accept',messageId:m.entityId}];else if(!c.deliveries.some(d=>d.actor===meta.actor)){const a=c.assignments[
     meta
       .actor],message=engine.core.store.list('message:').find(m=>m.recipient==='member:'+meta.actor&&m.accepted&&m.summary.includes('"cycle":'+c.id));if(
       message)call
     =['real_work',{op:'produce',value:a.own+JSON.parse(message.summary).value,messageId:message.entityId}]}}}
   }
 // The truncation fault: the provider answers exactly what the real route answered when the cap cut a member mid-write
  // -- status "incomplete", reason "max_output_tokens", a fragment of the step and no tool call. Everything downstream is
  // the real path, so this is the case the noSilentTruncation assertion has to catch offline.
  if(fault==='truncate-output'&&meta.purpose!=='replay'&&meta.purpose!=='cold-probe'){
    const cut={type:'reasoning',id:'rs_'+seq,summary:[],encrypted_content:'fake-signed:'+digest('rs_'+seq)};
    return {...base,status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
      usage:{...base.usage,output_tokens:route.maxOutputTokens},
      output:[cut,{type:'message',id:'msg_'+seq,role:'assistant',content:[{type:'output_text',text:'Writing the server:'}]}]};}
 const reasoning={type:'reasoning',id:'rs_'+seq,summary:[],encrypted_content:'fake-signed:'+digest('rs_'+seq)};return{...base,output:[reasoning,
   ...((batch?.length||call)?(batch?.length?batch:[call]).map((call,index)=>({
           type:'function_call',id:'fc_'+seq+'_'+index,call_id:'call_'+seq+'_'+index,name:call[0],arguments:JSON.stringify(call[1])})):
     [{type:'message',id:'msg_'+seq,role:
             'assistant',
           content:[{type:'output_text',text:fault==='invalid-tool-output'&&meta.purpose==='replay'&&meta.mode==='off'?'No interface marker received':
             'ALPHA7'}]}])]};
           }
   }
