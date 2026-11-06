// The smoke cap is 2,000,000 rather than 500,000 because every reservation now carries the 358,000-token output cap: a
// small smoke body reserves max(65536, bytes*4)+maxOutputTokens, about 423,536 where it used to be 98,304, so 500,000
// could not admit two in-flight smoke requests beside the 82,598 tokens the release ledger had already charged to this
// stage. 2,000,000 keeps about five concurrent worst-case reservations, which is what 500,000 bought at the old cap.
// The performance study is its own stage because it is a measurement run, not a workload: 30 cold and 30 warm samples,
// one mailbox wake cycle each, single concurrency, no fault and no background load. Its ceiling is 20,000,000 tokens,
// the budget this study was authorized with; the global cap is unchanged. The stage moves no release ceiling.
export const stages={smoke:2000000,'p2-replay':5000000,'model-contracts':10000000,soak:120000000,collab:77123800,performance:20000000};
// The output cap is a request parameter, not a suggestion: a response cut at it arrives as status "incomplete" with
// incomplete_details.reason "max_output_tokens", and 4096 cut every member that had to write a large file (the third
// real collaboration run: 17 of 95 responses in the control arm were truncated, and every truncated turn was reported
// as a normal end). The cap is now the largest value the route itself accepted in a live probe (see
// maxOutputTokensSource), and each request asks for at most that: the transport clamps it further to whatever the
// context window still leaves after the estimated input, so a long prompt gets a shorter answer instead of a refusal.
// The same gateway catalog is the source of the 1,000,000-token input window configured below. Output is asked for
// explicitly, so the gateway never falls back to its default.
// Set DSH_GATEWAY_URL to your own local gateway before a real-provider run (for example
// http://127.0.0.1:<port>/v1). The default refuses to connect.
const gatewayBaseURL = process.env.DSH_GATEWAY_URL ?? 'http://127.0.0.1:0/v1';
export const route={baseURL:gatewayBaseURL,model:'deepseek-v4.1-flash',protocol:'openai-responses',
  contextWindow:1000000,
  contextWindowSource:
    'gateway catalog (product-config-cn.json/-intl.json): deepseek-v4.1-flash maxInputTokens 1000000, contextWindow defaultLength 300000 up to 1000000; ' +
    'the profile keeps the conservative 1000000',
  maxOutputTokens:358000,
  maxOutputTokensSource:
  'live probe: gateway 127.0.0.1:<gateway-port> accepted max_output_tokens 358000 for deepseek-v4.1-flash ' +
  '(probe results <path-to-probe-results>/long4-ab/thinking-probe/maxtok/)'
    };
// The gate's configuration, derived from the route so the window and the output cap have one owner: W is the input
// window the transport's estimate is measured against, R the route's own output cap, M the uncertified-folding margin
// the gate reports and never reads (this stage runs no folding). packages/context/budget.mjs owns what they mean.
export const gate={W:route.contextWindow,R:route.maxOutputTokens,M:0};
export const topology=[['root','root','root'],['a1','worker','A'],['a2','worker','A'],['b1','worker','B'],['b2','worker','B'],['verifier','verifier',
    'independent']];
// The performance study enrolls only root. Its cold sessions are members the study creates one at a time (the product
// caps a team at 30 member rows, root included), so a rostered worker would only consume one of those rows.
export const performanceTopology=[['root','root','root']];
// The collaboration stage runs the plan's own team: three executors plus one independent verifier, all four writing
// code and running commands in their own workspace. It is a separate topology so none of the release stages change.
export const collabTopology=[['root','root','root'],['fe','worker','A'],['be','worker','A'],['qa','worker','A'],['verifier','verifier','independent']];
// Per-member request concurrency stays 1 by default so a member's own history is sequential; the global
// ceiling of 6 lets the six role-bound members hold one in-flight request each instead of queueing behind
// every other member. Raise only deliberately; a mailbox backlog behind one slot is what the 5s gate measured.
// The collaboration experiment is capped at 30 minutes a run (plan 11 section 5) and at the stage token cap above;
// both reuse the existing stop and budget machinery rather than adding a second clock or a second ledger.
// The stage ceiling and the progress window are two different limits and carry two different stop codes now
// (STAGE_TIME_LIMIT / NO_PROGRESS_STOP). The fourth real run showed why the progress window cannot be measured from
// the start of the stage: the control arm was cut at startedAt+900000 while all three affected members were inside
// the requirement change, one integration past all three artifacts, because the collaboration stage never advanced
// the progress clock the release stages advance on accept/produce/reply. It now advances on its own signals (a
// finished round, an integration, a produced delivery, a verification, a workspace write) and the window is measured
// from that; 300000 ms is longer than the 90 s a working member needs between two of those signals on the fourth
// run's own timestamps, and short enough that a genuinely silent team still ends the run well inside 30 minutes.
// Stage ceilings bound a native turn: default 16, soak 32, collab 80; repetition is independently bounded at 6.
// the collaboration stage asks a member to read, write and run its own tests before it answers, which the first two
// real runs showed needs more than 16 (the verifier alone issued 33 calls in one turn). Time and tokens stay guarded
// by the stage clock and the ledger, so the ceiling only has to be high enough that a productive turn is never cut.
// A run that repeats the same call is caught by repeatedToolCallLimit instead of by the ceiling.
export const policy={maxConcurrent:1,globalLimit:267400000,soakDurationMs:3600000,collabDurationMs:1800000,noProgressMs:900000,
  // The collaboration stage's own progress window. It is shorter than the release window because the workload emits
  // far more signals per minute, and it is measured from the last signal rather than from the stage start.
  collabNoProgressMs:300000,requestTimeoutMs:120000,
  globalConcurrency:6,stageConcurrency:{smoke:6,'p2-replay':6,'model-contracts':6,soak:6,collab:5},
  turnRequestLimit:{default:16,soak:32,collab:80},repeatedToolCallLimit:6};
/** The per-turn ceiling for one stage; every stage keeps its own value and a new stage inherits the release default. */
export const turnLimitFor=stage=>policy.turnRequestLimit[stage]??policy.turnRequestLimit.default;
