import assert from 'node:assert/strict';import {retain} from '../../packages/projections/retention.mjs';

// Live rows are never trimmed: an active intent, an unknown effect or attempt, and an uncompleted responsibility all
// need the operator or the next turn, so the projection keeps them however long the run is.
const rows=new Map();for(let i=0;i<20;i++)for(const [prefix,state] of [['member-intent:','intent'],['settle:','unknown'],['message:','accepted'],['task:',
      'produced'],['attempt:','unknown']])rows.set(prefix+i,{status:state,lease:state,updatedAt:i});
retain(rows,2);assert.equal(rows.size,100);
console.log('active intents, unknown effects/attempts and uncompleted responsibility retained PASS');

// §22.8: the families the host driver writes are archived once they are closed, exactly like the older ones. A long run
// that keeps a confirmed effect, its ledger, a visibility audit, a wake receipt or a dispatch receipt in memory grows
// without bound (the offline soak's 30-minute heap plateau caught it). Pending, applying and unknown effects stay, and
// the limit is the number of archived rows the map keeps in total - not a per-family budget.
{
 const rows=new Map();
 for(let i=0;i<20;i++){
  for(const [prefix,state] of [['effect:closed:','confirmed'],['effect-ledger:','none'],['visibility-audit:','none'],['wake-receipt:','none'],
      ['attempt-dispatch:',
        'none']])
   rows.set(prefix+i,{status:state,updatedAt:i});
  rows.set('effect:pending:'+i,{status:'pending',updatedAt:i});
  rows.set('effect:applying:'+i,{status:'applying',updatedAt:i});
  rows.set('effect:unknown:'+i,{status:'unknown',updatedAt:i});
 }
 retain(rows,2);
 const archived=id=>/^(effect:closed|effect-ledger|visibility-audit|wake-receipt|attempt-dispatch)/.test(id);
 assert.equal([...rows.keys()].filter(archived).length,2,'the limit is the number of archived rows kept in total');
 assert.equal([...rows.keys()].filter(id=>/^effect:(pending|applying|unknown)/.test(id)).length,60,
   'an effect that is pending, applying or unknown is not archived');
 assert.equal(rows.size,62);
 // An unknown effect outranks the limit: it is an operator decision, not history.
 const unknownOnly=new Map(Array.from({length:5},(_,i)=>['effect:u'+i,{status:'unknown',updatedAt:i}]));
 retain(unknownOnly,1);assert.equal(unknownOnly.size,5);
 console.log('closed host receipts archived, live effects retained PASS');
}

// §22.8: a ledger row belongs to its effect, so it is archived by that effect's status and never on its own. Trimming
// the ledger of an unknown or in-flight effect would leave the projection accounting for an effect it lost track of.
{
 const rows=new Map();
 for(let i=0;i<10;i++){
  rows.set('effect:open:'+i,{status:'unknown',updatedAt:i});
  rows.set('effect-ledger:open:'+i,{updatedAt:i});
  rows.set('effect:pending:'+i,{status:'pending',updatedAt:i});
  rows.set('effect-ledger:pending:'+i,{updatedAt:i});
  rows.set('effect:done:'+i,{status:'confirmed',updatedAt:i});
  rows.set('effect-ledger:done:'+i,{updatedAt:i});
  rows.set('effect-ledger:orphan:'+i,{updatedAt:i});
 }
 retain(rows,2);
 assert.equal([...rows.keys()].filter(id=>/^effect-ledger:(open|pending)/.test(id)).length,20,
   'the ledger of an unknown or in-flight effect is retained with it');
 assert.equal([...rows.keys()].filter(id=>/^effect:(open|pending)/.test(id)).length,20,'and those effects themselves stay');
 assert.equal([...rows.keys()].filter(id=>/^effect-ledger:(done|orphan)/.test(id)).length,2,
   'the ledger of a closed effect, and a ledger whose effect is gone, are archived like any other closed row');
 assert.equal([...rows.keys()].filter(id=>/^effect:done/.test(id)).length,0,'the closed effect itself is archived');
 console.log('effect-ledger follows its effect status PASS');
}