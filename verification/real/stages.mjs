import fs from 'node:fs';import {digest} from './protocol.mjs';
export async function compatibility(engine){engine.compatibilityMode=true;
  // F2b: the roster is created by the product, and every turn below is opened by the product too. A member's first turn
 // is the dispatch of the attempt its team.task.request schedules; root is the owner session, so the user speaks to it
 // directly. What the stage measures is unchanged: a peer's action carries the marker ALPHA7, the receiving side reads
 // it in its own request context, and a responsibility really is accepted against a live attempt.
 await engine.bind('root','compatibility');await engine.bind('a1','compatibility');
 // a1's single dispatched turn already ran (worker): it answered root's responsibility with the marker and, once that
 // responsibility had really been in one of its requests, accepted it against its live attempt. Root now reads the
 // action that came back from a peer and answers the exact marker it carries.
 // The truncation fault cuts every model step, so no tool call is ever made and no acceptance can be reached; that
 // run is judged by the truncation assertion, and waiting here would only turn it into a 120 s timeout that says
 // nothing about the output cap. Every other run keeps the acceptance requirement.
 if(engine.fault!=='truncate-output')await engine.untilAccepted('a1');
 await engine.turn('root',
   'Read the action member:a1 sent you in your structured snapshot and answer the exact interface marker it carries; do not call tools.');
 const session=engine.agent('a1').session;session.append('user/message',{id:'fixed-quality-question',role:'user',source:{kind:'user'},content:[{type:'text',
         text:'Fixed quality check: what exact interface marker did you send to member:root? Reply with only that marker. Do not use tools.'}]},{surfaceOp:
           'append'});
 await engine.ctx.sessions.flush(session);const frozen=structuredClone(session.deriveMessages()),sourceHash=digest(frozen);fs.writeFileSync(engine.root
   +'/replay-source.json',JSON.stringify({sourceHash,messages:frozen},null,2));
 const off=[];for(let i=0;i<2;i++)off.push(await engine.probe('a1',frozen,'off'));const onSourceHash=digest(session.deriveMessages());const fold=await engine
 .fold('a1');const onHistory=structuredClone(session.deriveMessages()),on=[];for(let i=0;i<2;i++)on.push(await engine.probe('a1',onHistory,'on'));const text
 =r=>(r.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join(' ').trim();
 engine.facts.replay
 ={actor:'a1',nativeSessionId:session.id,sourceHash,offSourceHash:sourceHash,onSourceHash,offWireHistoryHash:digest(frozen),onWireHistoryHash:digest(onHistory),
   offQuality:off.map(r=>markerOnly(text(r))),onQuality:on.map(r=>markerOnly(text(r))),rawAnswers:{off:off.map(text),on:on.map(text)},
   qualityQuestion:'exact interface marker ALPHA7',fold};await engine.cold('a1');const coldMessages=engine.agent('a1').session.deriveMessages();await engine
 .probe('a1',coldMessages,'on','cold-probe');return engine.facts.replay;
}
export async function workload(engine,{stage,mode,stopped}){let completed=0;engine.foldMode='on';while(!stopped()){const ok=await engine.workloadCycle(completed
      +1);if(!ok)throw Error('WORKLOAD_CYCLE_NOT_ACCEPTED');completed++;engine.facts.completedCycles=completed;await engine.fold('root');if(
      stage==='model-contracts'
      &&completed>=2||mode==='fake'&&completed>=2)break;}return completed;
  }
// Quality probe: the marker must be ALPHA7 exactly; the action kind prefix copied verbatim from the snapshot member text is tolerated.
function markerOnly(t){return /^(ACTION\s+)?ALPHA7$/.test(String(t).replace(/[`*"“”.]/g,"").trim())}
/** The opt-in performance study, re-exported here so run stage dispatch stays in one module. */
export { runPerformanceStudy as performance } from './performance-study.mjs';
/** The collaboration stage, re-exported here so run stage dispatch stays in one module. */
export { collab } from './collab-stage.mjs';
