/**
 * Per-member logical request / global physical transport gate.
 *
 * Ordinarily maxConcurrent limits actual requests per member. A step that has been preempted is different: its
 * provider operation may still be draining, but its result no longer owns the session and must not block the new step.
 * It continues to occupy a global physical slot and its budget reservation until the operation really settles. This
 * preserves the global IO ceiling and accounting while allowing the already-specified immediate follow-up.
 */
export class ConcurrencyGate {
  constructor({maxConcurrent=1,globalConcurrency=6}={}){
    this.maxConcurrent=Math.max(1,maxConcurrent|0);this.globalConcurrency=Math.max(1,globalConcurrency|0);
    this.active=new Map();this.physical=new Map();this.superseded=new Map();this.inFlight=0;this.queue=[];this.windows=[];
    this.peak=0;this.peakPerMember=0;this.peakActivePerMember=0;this.peakSuperseded=0;
    this.supersededTotal=0;this.overlapWithoutSupersession=0;this.admitted=0;this.settlementWaiters=new Set();
  }
  #canStart(actor){return this.inFlight<this.globalConcurrency&&(this.active.get(actor)??0)<this.maxConcurrent;}
  #decrement(map,actor){const n=(map.get(actor)??0)-1;if(n<=0)map.delete(actor);else map.set(actor,n);}
  acquire(actor,{signal}={}){
    const at=Date.now(),window={actor,requestedAt:at,grantedAt:null,releasedAt:null,supersededAt:null,ms:0};
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(Error('STEP_PREEMPTED_BEFORE_DISPATCH'));return;}
      const entry={actor,window,resolve,reject,signal,onAbort:null};
      entry.onAbort=()=>{const i=this.queue.indexOf(entry);if(i<0)return;this.queue.splice(i,1);
        signal.removeEventListener('abort',entry.onAbort);reject(Error('STEP_PREEMPTED_BEFORE_DISPATCH'));this.#pump();};
      signal?.addEventListener('abort',entry.onAbort,{once:true});this.queue.push(entry);this.#pump();
    });
  }
  #pump(){
    for(const entry of [...this.queue]){
      if(!this.#canStart(entry.actor))continue;
      this.queue.splice(this.queue.indexOf(entry),1);entry.signal?.removeEventListener('abort',entry.onAbort);
      const actor=entry.actor,window=entry.window;
      this.inFlight++;this.active.set(actor,(this.active.get(actor)??0)+1);this.physical.set(actor,(this.physical.get(actor)??0)+1);
      if(this.physical.get(actor)>this.maxConcurrent&&!(this.superseded.get(actor)>0))this.overlapWithoutSupersession++;
      this.admitted++;this.peak=Math.max(this.peak,this.inFlight);
      this.peakPerMember=Math.max(this.peakPerMember,this.physical.get(actor));
      this.peakActivePerMember=Math.max(this.peakActivePerMember,this.active.get(actor));
      window.grantedAt=Date.now();window.ms=window.grantedAt-window.requestedAt;this.windows.push(window);
      const release=()=>this.release(actor,window);release.window=window;release.supersede=()=>this.markSuperseded(actor,window);
      entry.resolve(release);
    }
    if(this.inFlight===0&&this.queue.length===0)for(const finish of [...this.settlementWaiters])finish(true);
  }
  /** Wait for actual IO and queued work, never just for a logical supersession. */
  whenSettled(timeoutMs){
    if(this.inFlight===0&&this.queue.length===0)return Promise.resolve(true);
    return new Promise(resolve=>{let timer;const finish=value=>{if(!this.settlementWaiters.delete(finish))return;
      clearTimeout(timer);resolve(value);};this.settlementWaiters.add(finish);timer=setTimeout(()=>finish(false),Math.max(0,timeoutMs));});
  }
  /** Retire only the session claim, never the real IO/global slot or its reservation. */
  markSuperseded(actor,window){
    if(window.releasedAt!==null||window.supersededAt!==null)return false;
    window.supersededAt=Date.now();this.#decrement(this.active,actor);this.superseded.set(actor,(this.superseded.get(actor)??0)+1);
    this.supersededTotal++;this.peakSuperseded=Math.max(this.peakSuperseded,[...this.superseded.values()].reduce((a,b)=>a+b,0));
    this.#pump();return true;
  }
  release(actor,window){
    if(!window||window.releasedAt!==null)return false;
    if(window.supersededAt===null)this.#decrement(this.active,actor);else this.#decrement(this.superseded,actor);
    this.#decrement(this.physical,actor);this.inFlight--;window.releasedAt=Date.now();window.heldMs=window.releasedAt-window.grantedAt;
    this.#pump();return true;
  }
  /** A queued preempted step never starts; an in-flight one keeps its physical slot until work settles. */
  async run(actor,work,{signal}={}){
    const at=Date.now(),release=await this.acquire(actor,{signal});
    if(signal?.aborted){release();throw Error('STEP_PREEMPTED_BEFORE_DISPATCH');}
    const onAbort=()=>release.supersede();signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){signal.removeEventListener('abort',onAbort);release();throw Error('STEP_PREEMPTED_BEFORE_DISPATCH');}
    try{return await work(release.window,Date.now()-at)}finally{signal?.removeEventListener('abort',onAbort);release();}
  }
  stats(){return{maxConcurrent:this.maxConcurrent,globalConcurrency:this.globalConcurrency,admitted:this.admitted,
    peakInFlight:this.peak,peakPerMember:this.peakPerMember,peakActivePerMember:this.peakActivePerMember,
    inFlight:this.inFlight,supersededInFlight:[...this.superseded.values()].reduce((a,b)=>a+b,0),
    peakSuperseded:this.peakSuperseded,supersededTotal:this.supersededTotal,overlapWithoutSupersession:this.overlapWithoutSupersession,
    queued:this.queue.length,wait:{count:this.windows.length,maxMs:this.windows.length?Math.max(...this.windows.map(w=>w.ms)):0,
      totalMs:this.windows.reduce((n,w)=>n+w.ms,0)}}}
}

/** Milliseconds a member spent waiting for a slot inside [from,to]; used to split mailbox latency. */
export function slotWaitWithin(windows,actor,from,to){
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return 0;
  let total=0;
  for(const w of windows){
    if(w.actor!==actor||w.grantedAt===null)continue;
    const start=Math.max(from,w.requestedAt),end=Math.min(to,w.grantedAt);
    if(end>start)total+=end-start;
  }
  return Math.min(total,to-from);
}
