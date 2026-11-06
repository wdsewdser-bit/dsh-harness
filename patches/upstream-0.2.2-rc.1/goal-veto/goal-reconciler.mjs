import fs from 'node:fs';
import path from 'node:path';
// Reference durable adapter. P3b must replace this single-writer file store with its ledger transaction.
export class GoalReconciler {
 constructor({ledgerPath,alarm=()=>{}}){this.file=ledgerPath;this.alarm=alarm;this.ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{version:1,approvals:[],violations:[]};if(this.ledger.version!==1)throw Error('unknown reconciliation ledger');}
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(this.ledger,null,2));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,this.file);}
 approve(input,operationId){if(typeof operationId!=='string'||!operationId)throw Error('operationId required');const g=input.goal;const token={operationId,sessionId:input.sessionId,goalId:g.id,revision:g.revision+1,objective:g.objective,maxGoalRounds:g.maxGoalRounds};if(this.ledger.approvals.some(a=>a.operationId===operationId||a.sessionId===token.sessionId&&a.goalId===token.goalId&&a.revision===token.revision))throw Error('duplicate approval');this.ledger.approvals.push(token);try{this.save()}catch(e){this.ledger.approvals.pop();throw e}return true;}
 inspect(session,event){if(event.type!=='goal/change'||event.data?.goal?.phase!=='complete')return;const g=event.data.goal;
 // Conservatively require a token for every complete snapshot, including an edit preserving complete.

 const token=this.ledger.approvals.find(a=>a.sessionId===session.id&&a.goalId===g.id&&a.revision===g.revision&&a.objective===g.objective&&a.maxGoalRounds===g.maxGoalRounds);
 if(token)return;
 const violation={kind:'inconsistency',code:'GOAL_COMPLETE_WITHOUT_APPROVAL',sessionId:session.id,seq:event.seq,goalId:g.id,revision:g.revision};
 if(!this.ledger.violations.some(v=>v.sessionId===violation.sessionId&&v.seq===violation.seq)){this.ledger.violations.push(violation);this.save();this.alarm(violation)}
 }
 attach(ctx){return ctx.on('session/event',(s,e)=>this.inspect(s,e));}
 reconcile(session){for(const event of session.snapshotEvents())this.inspect(session,event);return this.snapshot();}
 snapshot(){return structuredClone({violations:this.ledger.violations,teamAcceptance:this.ledger.violations.length?'unknown':'not-unknown',approvals:this.ledger.approvals});}
}