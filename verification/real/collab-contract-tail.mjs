import assert from 'node:assert/strict';
import {autonomyConfig,AUTONOMY_CODES,autonomyCodeList,codes} from '../../packages/contracts/index.mjs';
import {nativeEntries, nativeEntriesFor} from './native-host.mjs';
import {BASH_PIN_MODULE, bashPinEntry} from '../../packages/profiles/shell-entries.mjs';

/** Contract checks 7-9 (autonomy defaults, error-code table, native host entries), split out of the entry script. */
export function runContractTail(checks) {
// 7. P0 of team-autonomy: the contract and the switches, and nothing else.
//    No autonomy behaviour is wired in this repository yet, so the only things that can be pinned are the names, the
//    defaults and the refusal of an illegal value. Every default below is today's behaviour (the switch is off, the
//    goal gate stays at its F2 status), which is what makes this P0 additive for every existing profile.
{
  const defaults=autonomyConfig();
  assert.equal(defaults.autonomy,'off','the autonomy switch is off: the product is what it is today');
  assert.deepEqual(defaults.goalGate,{strict:false,legacy:'adopt-tail'},'F2 status: the chain root is still the first accepted base');
  assert.equal(defaults.stopGraceMs,5000);
  assert.equal(defaults.stopProofTimeoutMs,10000);
  assert.equal(defaults.decisionTtlMs,900000,'U8: a decision row expires after 15 minutes by default');
  assert.deepEqual(defaults.budget,{unknownUsage:'continue',unknownGraceMs:1800000},'U2: an unmeasured count does not stop the team');
  assert.equal(defaults.pricing,null,'without a price table the projection carries no cost');
  assert(Object.isFrozen(defaults)&&Object.isFrozen(defaults.goalGate)&&Object.isFrozen(defaults.budget),
    'a switch that can be edited after the mount is not a contract');
  // A value the contract does not define, or one outside its range, is refused - never defaulted away.
  for(const bad of [{autonomy:'yes'},{nope:true},{goalGate:{strict:'true'}},{goalGate:{legacy:'refuse'}},
    {stopGraceMs:'5s'},{stopGraceMs:-1},{decisionTtlMs:1000},{budget:{unknownUsage:'maybe'}},
    {pricing:{currency:'USD'}},{pricing:{currency:'USD',perInputToken:-1,perOutputToken:0}}]){
    assert.throws(()=>autonomyConfig(bad),error=>error&&error.code==='INVALID_CONFIG','refused: '+JSON.stringify(bad));
  }
  const priced=autonomyConfig({autonomy:'on',pricing:{currency:'USD',perInputToken:0.000003,perOutputToken:0.000015}});
  assert.equal(priced.autonomy,'on');assert.equal(priced.pricing.perOutputToken,0.000015);
  assert.equal(priced.goalGate.strict,false,'turning the switch on does not move the F2 default on its own');
  checks.push('autonomy contract: off by default, F2 goal-gate status, 15-minute decision TTL, no pricing means no cost, illegal values are INVALID_CONFIG');
}

// 8. The error-code table: each name the autonomy packages will raise exists once, and the published list carries it.
{
  const flattened=Object.values(AUTONOMY_CODES).flat();
  assert.deepEqual([...autonomyCodeList],flattened,'one flat list, built from the grouped table');
  assert.equal(new Set(flattened).size,flattened.length,'no code is published twice');
  for(const code of flattened)assert(codes.includes(code),code+' must appear in the published codes list');
  for(const code of ['SELF_ADDRESSED','DECISION_STALE','SELF_JUDGE_DENIED','TEAM_GOAL_REQUIRED','TEAM_GOAL_TOO_LATE',
    'TARGET_BASE_UNRECORDED','TARGET_ALREADY_HAS_DELIVERIES','UNVERIFIED_LEGACY_BASE','PID_REUSED','INVALID_BUDGET_FIELD',
    'DELEGATION_CONCURRENCY','DELEGATION_TOKEN_BUDGET','INVALID_WORKSPACE','INVALID_CONFIG']){
    assert(codes.includes(code),code+' is named by the design and must be published');
  }
  checks.push('error codes: one grouped table, flattened into the published list, no duplicates, every design code present');
}

// 9. P9 (appendix 9): with the switch ON the profile owns the subprocess provider - installRuntime subclasses the local
//    provider so every spawn is attributed and reaped for the stop proof, and it mounts that subclass only when nothing
//    else provides the service. So the native set must not load the upstream package as well; with the switch OFF not one
//    byte of the list may move. The comparison is static on purpose: booting the Loader to read one list would start the
//    whole native capability set (fs, sandbox, bash, jobs) for nothing, and the live path is what this must not disturb.
{
  // WP-D: exactly one shell provider, and which row it is depends on the platform the host runs on. The expectation is
  // built for both arms on every machine, so the non-win32 arm is still asserted byte for byte against what HEAD
  // published - a Windows-only change may not move the POSIX list.
  const shellRow=platform=>platform==='win32'?bashPinEntry(platform):{id:'native-bash-local',name:'@deepseek-ai/dsh-bash-local'};
  const frozenFor=platform=>[
    {id:'native-fs',name:'@deepseek-ai/dsh-fs-local'},
    {id:'native-sandbox',name:'@deepseek-ai/dsh-sandbox-local'},
    {id:'native-attachment',name:'@deepseek-ai/dsh-attachment-local'},
    {id:'native-tool-fs',name:'@deepseek-ai/dsh-tool-fs'},
    {id:'native-working-directory',name:'@deepseek-ai/dsh-working-directory',config:{defaultDirectory:'/repo/root/default'}},
    {id:'native-sandbox-policy',name:'@deepseek-ai/dsh-sandbox-policy',config:{mode:'workspace-write',workspaceRoot:'/repo/root'}},
    {id:'native-subprocess',name:'@deepseek-ai/dsh-subprocess-local'},
    {id:'native-shell-env',name:'@deepseek-ai/dsh-shell-env'},
    shellRow(platform),
    {id:'native-tool-bash',name:'@deepseek-ai/dsh-tool-bash'},
    {id:'native-jobs',name:'@deepseek-ai/dsh-jobs-local'},
  ];
  const frozen=frozenFor(process.platform);
  const off=nativeEntriesFor({},'/repo/root','/repo/root/default');
  assert.equal(JSON.stringify(off),JSON.stringify(frozen),'autonomy off: the native entry set is byte for byte what this platform publishes');
  assert.deepEqual(nativeEntries('/repo/root','/repo/root/default'),frozen,'the option defaults to off');
  assert.equal(JSON.stringify(nativeEntries('/repo/root','/repo/root/default',{platform:'linux'})),JSON.stringify(frozenFor('linux')),
    'non-win32: the native entry set is byte for byte what HEAD published');
  assert.equal(frozen.filter(entry=>/@deepseek-ai\/dsh-bash-local|shell-bash-pin|pwsh/.test(entry.name)).length,1,
    'exactly one shell provider (the pinned executor on win32, the upstream one elsewhere), never a pwsh row');
  for(const value of [undefined,'off']){
    assert.equal(JSON.stringify(nativeEntriesFor({autonomy:value},'/repo/root','/repo/root/default')),JSON.stringify(frozen),'switch '+String(value)
      +' keeps the control arm');
  }
  const profileOwnsShell=nativeEntries('/repo/root','/repo/root/default',{shell:'git-bash'});
  assert.equal(profileOwnsShell.some(entry=>entry.name===BASH_PIN_MODULE),false,
    'shell:git-bash: the native set adds no bash-pin module of its own - the profile owns that provider');
  const on=nativeEntriesFor({autonomy:'on'},'/repo/root','/repo/root/default');
  assert.deepEqual(on,frozen.filter(entry=>entry.id!=='native-subprocess'),
    'autonomy on: the taken-over entry is absent and every other entry keeps its place');
  assert.equal(on.some(entry=>entry.name==='@deepseek-ai/dsh-subprocess-local'),false,
    'one provider per context: the upstream package is never loaded beside the profile subclass');
  assert.equal(frozen.filter(entry=>entry.name==='@deepseek-ai/dsh-subprocess-local').length,1,
    'and the control arm keeps exactly the one it always had');
  checks.push('native host entries: off is byte-identical to HEAD; on is that same list minus the one provider the profile itself mounts (stop proof keeps ' +
    'its ' +
    
    
    'handles, no second service owner)');
}
}
