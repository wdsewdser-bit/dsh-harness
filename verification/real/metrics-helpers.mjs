// The codes that mean "the harness's own clock ended a healthy run", as opposed to a defect or a budget end:
// TIME_STOP is the soak's hour, STAGE_TIME_LIMIT the collaboration stage's own ceiling. The two are separate codes
// because the collaboration stage's other clock -- the progress window -- must stay a defect and keep its own code.
export const clockStopCodes=['TIME_STOP','STAGE_TIME_LIMIT'];
export const quantile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.max(0,Math.ceil(a.length*p)-1)]:null;
export function slope(rows,key='inputTokens') {
  if(rows.length<2||rows.some(x=>!Number.isFinite(x[key])))return null;
  const x=(rows.length-1)/2,y=rows.reduce((n,r)=>n+r[key],0)/rows.length;
  return rows.reduce((v,r,i)=>v+(i-x)*(r[key]-y),0)/rows.reduce((v,_,i)=>v+(i-x)**2,0);
}
/**
 * An assertion whose premise never happened is not a passing assertion.
 *
 * It is reported by name instead, so a run that ended early says which mechanism it never reached and why, rather than
 * turning an absence of evidence into a verdict. The value is deliberately not `true`: the run still fails, it just
 * fails with the reason stated.
 */
export const notExercised = reason => 'not-exercised: ' + reason;

/** A superseded provider operation remains physical IO; only its session claim may overlap a replacement. */
export function concurrencyGateHonest(gate,budgetViolations=[]){
  if(!gate)return false;
  const physical=gate.peakPerMember,active=gate.peakActivePerMember??physical,superseded=gate.peakSuperseded??0;
  return gate.peakInFlight<=gate.globalConcurrency&&active<=gate.maxConcurrent&&
    physical<=gate.maxConcurrent+superseded&&(gate.overlapWithoutSupersession??0)===0&&
    (gate.inFlight??0)===0&&gate.queued===0&&budgetViolations.length===0;
}

/** Sum one numeric column, or null when no row reported it: an absent counter is not zero. */
export const columnSum=(rows,key)=>rows.some(row=>row[key]!==null&&row[key]!==undefined)?rows.reduce((n,row)=>n+(row[key]??0),0):null;
export const costTotals=rows=>({requests:rows.length,input:columnSum(rows,'input'),output:columnSum(rows,'output'),
  cacheHit:columnSum(rows,'cacheHit'),cacheMiss:columnSum(rows,'cacheMiss'),
  inputPlusOutput:(columnSum(rows,'input')??0)+(columnSum(rows,'output')??0),reported:columnSum(rows,'reported')});
export const groupCost=(rows,key)=>Object.fromEntries([...new Set(rows.map(row=>String(row[key])))].sort()
  .map(group=>[group,{...costTotals(rows.filter(row=>String(row[key])===group)),requests:rows.filter(row=>String(row[key])===group).length}]));
