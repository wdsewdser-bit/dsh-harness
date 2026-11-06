import assert from 'node:assert/strict';import {Projection} from '../../packages/projections/index.mjs';
export function retentionTest(core){const reader={events:n=>core.store.events(n),scanEvents:n=>core.store.scanEvents(n)},p=new Projection(reader,{recentLimit:8
      });const before=p.snapshot('member:root').asOfSeq;
for(let n=0;n<50;n++){const m=core.send('member:root','member:a','info','retention').result;core.mutate(m.entityId,'root',{},(tx,r)=>tx.put(m.entityId,{...r,
        status:'resolved'}));p.snapshot('member:root');
  }
assert(p.history.length<=8&&p.latency.length<=8);assert(p.rows.size<30);const replay=p.events('member:root',before);assert.equal(replay.length,100);
assert.deepEqual(replay.map(e=>e.seq),Array.from({length:100},(_,n)=>before+n+1));assert.deepEqual(new Projection(reader,{recentLimit:8
      }).snapshot('member:root'),
  p
  .snapshot('member:root'));assert.equal(p.events('member:root',before,{limit:8}).length,8);return p.stats();
  }
