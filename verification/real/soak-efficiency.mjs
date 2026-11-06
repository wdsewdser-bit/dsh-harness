import assert from 'node:assert/strict';

// Fake models batching, but must still pass through all four real product verification operations per cycle.
export function assertReviewEfficiency(facts) {
  for(let cycle=1;cycle<=facts.completedCycles;cycle++) {
    const deliveries=facts.deliveries.filter(d=>d.cycle===cycle),requests=facts.requests.filter(r=>r.actor==='verifier'&&r.cycle===cycle);
    assert.equal(deliveries.length,4);assert(deliveries.every(d=>d.status==='accepted'&&d.certificate));
    assert(requests.length>0&&requests.length<=3,'one accept, one independent review batch, one final response');
    assert(requests.every(r=>r.at>=Math.max(...deliveries.map(d=>d.producedAt))),'verifier cannot poll before all deliveries exist');
    assert(requests.every(r=>Number.isInteger(r.nativeTurn)&&Number.isInteger(r.turnRequest)),'requests identify their native turn');
    const ids=new Set(requests.map(r=>r.requestId));
    const reviews=facts.toolActions.filter(a=>a.actor==='verifier'&&a.args?.op==='review'&&ids.has(a.requestId));
    assert.equal(reviews.length,4,'batching must not remove work');
    assert.equal(new Set(reviews.map(r=>r.requestId)).size,1,'independent reviews share one model step');
    for(const d of deliveries)assert.equal(reviews.filter(r=>[d.id,d.deliveryId].includes(r.args.deliveryId)).length,1);
    assert(reviews.some(r=>r.args.deliveryId.startsWith('artifact:')));
    assert(reviews.some(r=>r.args.deliveryId.startsWith('delivery:')),'both published ID forms execute through the real review path');
  }
}
