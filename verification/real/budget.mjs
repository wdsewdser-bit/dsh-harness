import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {stages,policy} from './config.mjs';

/**
 * Durable pre-request reservation ledger with an exclusive critical section.
 *
 * Every request reserves its worst-case bound before dispatch and settles actual usage afterwards, so two
 * requests in flight at once cannot each spend the same remaining headroom and jointly overrun the stage or
 * global cap. Outstanding reservations are listed durably under "pending": a crash leaves them behind and the
 * next open refuses to continue until an operator reconciles them against provider accounting. Cross-process
 * ownership is the exclusive create of "<ledger>.lock"; intra-process serialization is the exclusive() gate.
 */
export class Budget {
  constructor(file,stage,{readonly=false}={}){
    this.file=file;this.stage=stage;this.readonly=readonly;this.depth=0;this.reservations=new Map();
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(!readonly){this.lock=fs.openSync(file+'.lock','wx');fs.writeSync(this.lock,JSON.stringify({pid:process.pid,stage}));}
    try{
      this.data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,total:0,stages:{},input:0,output:0,cacheHit:0,cacheMiss:0,pending:null};
      if(this.data.version!==1||!Number.isSafeInteger(this.data.total)||this.data.total<0||this.data.pending)throw Error(
        'BUDGET_LEDGER_REQUIRES_RECONCILIATION');
      for(const v of Object.values(this.data.stages))if(!Number.isSafeInteger(v)||v<0)throw Error('BUDGET_LEDGER_INVALID');
    }catch(e){this.close();throw e}
  }
  /** One exclusive critical section around every read-modify-write of the ledger. */
  exclusive(fn){
    if(this.depth)throw Error('BUDGET_LOCK_REENTRANT');
    this.depth++;
    try{return fn()}finally{this.depth--}
  }
  save(){if(this.readonly)return;const tmp=this.file+'.tmp';const fd=fs.openSync(tmp,'w');try{fs.writeSync(fd,JSON.stringify(this.data,null,2));fs.fsyncSync(fd)
      }finally{fs.closeSync(fd)}fs.renameSync(tmp,this.file)
    }
  /** Reserve nothing for this stage's bound; mirrors pendingOutstanding() for accounting and reporting. */
  committed(){return [...this.reservations.values()].reduce((n,r)=>n+r.bound,0)}
  committedFor(stage){return [...this.reservations.values()].reduce((n,r)=>n+(r.stage===stage?r.bound:0),0)}
  outstanding(){return this.reservations.size}
  canAdmit(bound){
    return Number.isSafeInteger(bound)&&bound>0&&
      this.data.total+this.committed()+bound<=policy.globalLimit&&
      (this.data.stages[this.stage]??0)+this.committedFor(this.stage)+bound<=stages[this.stage];
  }
  /** Reserve before dispatch; returns the token that later settles the exact reservation. */
  reserve(bound){
    if(this.readonly)throw Error('READONLY_BUDGET');
    return this.exclusive(()=>{
      if(!this.canAdmit(bound))throw Error('BUDGET_STOP_BEFORE_REQUEST');
      const token='reservation:'+randomUUID();
      this.reservations.set(token,{stage:this.stage,bound,at:Date.now()});
      this.data.pending=this.snapshot();
      this.save();
      return token;
    });
  }
  snapshot(){return this.reservations.size?Object.fromEntries(this.reservations):null}
  /** Drop a reservation that provably never reached the provider. */
  release(token){
    return this.exclusive(()=>{
      if(!this.reservations.delete(token))return false;
      this.data.pending=this.snapshot();this.save();return true;
    });
  }
  settle(u,token){
    return this.exclusive(()=>{
      const resolved=token??(this.reservations.size===1?[...this.reservations.keys()][0]:null);
      const reservation=resolved?this.reservations.get(resolved):null;
      if(!reservation)throw Error('NO_RESERVATION');
      if(!u||!Number.isSafeInteger(u.input)||!Number.isSafeInteger(u.output)||u.input<0||u.output<0)throw Error('UNKNOWN_USAGE_REQUIRES_RECONCILIATION');
      const n=u.input+u.output;
      this.data.total+=n;this.data.stages[this.stage]=(this.data.stages[this.stage]??0)+n;
      this.data.input+=u.input;this.data.output+=u.output;
      if(u.cacheHit!==null)this.data.cacheHit+=u.cacheHit;
      if(u.cacheMiss!==null)this.data.cacheMiss+=u.cacheMiss;
      this.reservations.delete(resolved);
      const overrun=n>reservation.bound;
      this.data.pending=overrun?{reason:'PROVIDER_EXCEEDED_RESERVATION',bound:reservation.bound,actual:n}:this.snapshot();
      this.save();
      if(overrun)throw Error('USAGE_BOUND_VIOLATION');
      return {total:this.data.total,remaining:this.reservations.size};
    });
  }
  // On an undrained transport, leave the lock file in place: late usage may still update this ledger and another
  // process must not acquire it. The pending reservation and retained lock then require operator reconciliation.
  close({retainLock=false}={}){
    if(this.lock!==undefined){fs.closeSync(this.lock);this.lock=undefined;
      if(!retainLock)try{fs.unlinkSync(this.file+'.lock')}catch{}}
  }
}
export function usage(raw){const i=raw?.input_tokens??raw?.prompt_tokens,o=raw?.output_tokens??raw?.completion_tokens;const hit
  =raw?.input_tokens_details?.cached_tokens??raw?.prompt_tokens_details?.cached_tokens??raw?.prompt_cache_hit_tokens??null;return {input:i,output:o,cacheHit:
    hit,
    cacheMiss:raw?.prompt_cache_miss_tokens??(Number.isInteger(hit)&&Number.isInteger(i)?i-hit:null),cost:raw?.cost??null}
  }
