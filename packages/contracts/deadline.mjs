import {failWith} from './index.mjs';
export const deadlineDescription='Deadline: absolute timestamp (RFC3339 recommended), or ISO 8601 fixed duration e.g. PT5M, PT30S, P1D. Duration is converted once at server admission, 1 second to 7 days inclusive; absolute time must be future and at most 7 days away. Calendar years/months and weeks are unsupported. Identical operationId retries retain the original deadline.';
export const deadlineSchema={type:'string',minLength:1,description:deadlineDescription};
/**
 * Everything the refusal may say about what was accepted, published in the refusal itself.
 *
 * A bare INVALID_DEADLINE told the caller nothing: the second real collaboration run spent a request on an absolute
 * timestamp that was already in the past and could only guess why it was refused. The code is unchanged (it is what the
 * protocol classifier reads); the detail now names the form, the reason and the server clock the value was judged on.
 */
const accepted='accepted forms are a future RFC3339 timestamp at most 7 days ahead, or a fixed ISO 8601 duration from PT1S to P7D (e.g. PT5M, PT30S, P1D; calendar months/years/weeks unsupported)';
const refuse=detail=>failWith('INVALID_DEADLINE',detail+'; '+accepted);
export function normalizeDeadline(value,now=Date.now()){
  if(typeof value!=='string')refuse('deadline must be a string, got '+JSON.stringify(value));
  let target;
  if(value.startsWith('P')){
    const m=/^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+(?:[.][0-9]{1,3})?)S)?)?$/.exec(value);
    if(!m||!m.slice(1).some(x=>x!==undefined)||value.endsWith('T'))refuse(value+' is not a fixed-duration literal (calendar parts are not durations)');
    const ms=((Number(m[1]??0)*24+Number(m[2]??0))*60+Number(m[3]??0))*60000+Number(m[4]??0)*1000;
    if(!Number.isFinite(ms)||ms<1000||ms>604800000)refuse(value+' is outside the 1 second to 7 day duration range');
    target=now+ms;
  }else{
    target=Date.parse(value);
    if(!Number.isFinite(target))refuse(value+' is neither a fixed duration nor a parseable timestamp');
    if(target<=now)refuse(value+' is at or before the server time '+new Date(now).toISOString()+' (a duration is relative to that clock)');
    if(target>now+604800000)refuse(value+' is more than 7 days after the server time '+new Date(now).toISOString());
  }
  return new Date(target).toISOString();
}
export function normalizeToolDeadlines(args,now=Date.now()){
  const result={...args};
  if(Object.hasOwn(args,'deadline'))result.deadline=normalizeDeadline(args.deadline,now);
  if(args.dependency?.kind==='ExternalEvidence')result.dependency={...args.dependency,deadline:normalizeDeadline(args.dependency.deadline,now)};
  return result;
}
