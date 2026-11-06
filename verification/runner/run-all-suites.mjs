/**
 * A suite is { id, args, cwd?, expect[], needsRoot? }.
 *
 * args may contain the placeholders {root} (a scratch directory that does not exist yet: every suite that
 * takes a root asserts it is new, and creates it itself) and {report} (the JSON report path for the
 * verification/run.mjs suites, kept inside the scratch tree instead of reports/).
 *
 * expect is the suite's own success evidence, matched against the combined stdout+stderr. Exit code 0 alone is
 * not accepted: an exit code with no output, or output without the suite's own pass marker, fails the run
 * ("zero tests, green run" is the failure mode this guards against).
 */
export const suites = [
  {
    // F2: the F1 driver switch is deleted, not merely defaulted away. This suite fails if any code under packages/ or
    // verification/ still names the removed driver or its harness-only error; since F2b there is no exempt directory.
    id: 'driver-surface',
    args: ['verification/unit/check-driver-surface.mjs'],
    expect: [/driver surface: PASS/],
  },
  { id: 'm1b-profile-e2e', args: ['verification/e2e/m1b-profile-e2e.mjs'], expect: [/m1b-profile-e2e: PASS/] },
  // --- package unit suites (node:test, no provider, no filesystem scope) ---
  { id: 'adapter-build', args: ['--test', 'verification/unit/build-target.test.mjs', 'verification/unit/borrow-release-build.test.mjs',
      'verification/unit/driver-surface.test.mjs',
      'verification/unit/failure-diagnostics.test.mjs', 'verification/unit/context-budget.test.mjs',
      'verification/unit/context-budget-transport.test.mjs', 'verification/unit/p4-web-poll.test.mjs',
      'verification/unit/timing-metrics.test.mjs', 'verification/unit/real-dispose.test.mjs', 'verification/unit/test-cleanup.test.mjs',
      'verification/unit/stop-errors.test.mjs', 'verification/unit/mailbox-late-delivery.test.mjs', 'verification/unit/turn-alert.test.mjs',
      'verification/unit/decision-renewal.test.mjs', 'verification/unit/git-bash-build-patch.test.mjs'], expect: [/pass [1-9]\d*/, /fail 0/] },
  // P0 of the super-agent borrow design (docs/decisions/superagent-borrow-design.md §10): the protocol contract, the
  // migration prerequisites, the source/capability contract, the off golden against 5325aeb, and the §11 probes. Offline
  // like every suite here: the golden extracts a throwaway `git archive` of the baseline, the wake probe boots the
  // prepared build in-process over a temp root (the same shape the wake-contract suite already uses), and no provider,
  // listener or port is touched.
  {
    id: 'superagent-borrow',
    args: ['--test', 'verification/unit/superagent-borrow-p0.test.mjs',
      'verification/unit/superagent-borrow-p0-contract.test.mjs', 'verification/unit/superagent-borrow-probe.test.mjs'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  // P5 (§3.2, §5, §6, §9, §10 P5): the v1 projection surface/SSE/retention/command authorization, and the acceptance
  // manifest that checks every §9 T/R/B/H case is attached to a test file in the suites below.
  {
    id: 'superagent-borrow-p5',
    args: ['--test', 'verification/unit/superagent-borrow-p5.test.mjs', 'verification/unit/superagent-borrow-p5-review.test.mjs',
      'verification/unit/superagent-borrow-acceptance.test.mjs'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  // §9 performance half: request counts, batch size and bounded occupancy only; no live latency is claimed.
  {
    id: 'superagent-borrow-performance',
    args: ['--test', 'verification/unit/superagent-borrow-performance.test.mjs'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  // §9 profile-only integration: S1-S4 main path through the real store/core/host/projection, no provider and no test
  // turn driver. It also pins that the public profile entry still refuses v1.
  {
    id: 'superagent-borrow-profile-e2e',
    args: ['--test', 'verification/e2e/superagent-borrow-profile-e2e.test.mjs'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  { id: 'real/session-state', args: ['--test', 'verification/real/session-state.test.mjs'], expect: [/pass [1-9]\d*/, /fail 0/] },
  {
    id: 'ui',
    cwd: 'packages/ui',
    args: ['--test'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  {
    id: 'core',
    cwd: 'packages/core',
    args: ['--test'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  {
    // P7 (docs/decisions/team-autonomy-design.md §10 P7): the profile package's own suites enter the root regression.
    // They boot the real profile (offline, in-process) and cover the in-process stop proof and the usage measurement
    // boundary; before this they ran only by hand, which is how a broken stop proof survived to review.
    //
    // One file at a time, deliberately: two of these suites spawn real OS processes and read their pids back from a
    // heartbeat file, and node runs test FILES in parallel by default. Concurrently, each one's readback races the
    // other's teardown (the e2e read NaN where it expected its own pid), which is a property of the fixture, not of the
    // product. Serial execution is the honest way to run a suite that asserts about the operating system.
    id: 'profiles',
    cwd: 'packages/profiles',
    args: ['--test', '--test-concurrency=1'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },
  {
    // M1a host skeleton: ownership, lifecycle state machine, session routing and the command gateway interface.
    // The only filesystem it touches is a throwaway directory per test under the system temp root (os.tmpdir());
    // it never opens runs/, reports/ or a profile store, and it starts no timers that drive a team.
    id: 'host',
    cwd: 'packages/host',
    args: ['--test'],
    expect: [/pass [1-9]\d*/, /fail 0/],
  },

  // --- P2/P3 core suites dispatched by verification/run.mjs ---
  // These four take a throwaway root under the scratch tree and a report path in the same tree. They boot the
  // offline/scripted provider path only. p3-team and p3-regressions are deliberately absent: the product code
  // they exercise (packages/delivery/index.mjs git()) refuses any repository outside runs/ ("GIT_SCOPE"), and
  // this milestone must not write into runs/ (see the exclusion notes below).
  { id: 'p2-context', args: ['verification/integration/run.mjs', 'p2-context', '--root', '{root}', '--report', '{report}'], expect: [/p2-context: PASS/],
    needsRoot: true },
  { id: 'p2-faults', args: ['verification/integration/run.mjs', 'p2-faults', '--root', '{root}', '--report', '{report}'], expect: [/p2-faults: PASS/],
    needsRoot: true },
  { id: 'p3-core', args: ['verification/integration/run.mjs', 'p3-core', '--profile', 'team', '--root', '{root}', '--report', '{report}'],
    expect: [/p3-core: PASS/], needsRoot: true },
  {
    id: 'p3-model-contracts',
    args: ['verification/integration/run.mjs', 'p3-model-contracts', '--profile', 'team', '--scenario', 'cross-peer-dependency', '--root', '{root}', '--report',
      '{report}'],
    expect: [/p3-model-contracts: PASS/],
    needsRoot: true,
  },

  // --- offline provider-free suites under verification/real (fake/scripted transport, zero provider requests) ---
  { id: 'real/preempt-copy', args: ['verification/real/preempt-copy-test.mjs', '{root}'], expect: [/instant preempt copy PASS/], needsRoot: true,
    rootBase: 'runs' },
  { id: 'real/safety-test', args: ['verification/real/safety-test.mjs', '{root}'], expect: [/safety PASS/], needsRoot: true },
  { id: 'real/tool-contract-test', args: ['verification/real/tool-contract-test.mjs', '{root}'], expect: [/tool contract tests PASS/], needsRoot: true },
  { id: 'real/collab-contract-test', args: ['verification/real/collab-contract-test.mjs', '{root}'], expect: [/collab contract tests PASS/], needsRoot: true },
  { id: 'real/deadline-protocol-test', args: ['verification/real/deadline-protocol-test.mjs', '{root}'], expect: [/deadline\/protocol recovery tests PASS/],
    needsRoot: true },
  { id: 'real/workload-guard-test', args: ['verification/real/workload-guard-test.mjs', '{root}'], expect: [/workload guard tests PASS/], needsRoot: true },
  { id: 'real/concurrency-test', args: ['verification/real/concurrency-test.mjs', '{root}'], expect: [/concurrency\/budget gate PASS/], needsRoot: true },
  { id: 'real/tool-output-test', args: ['verification/real/tool-output-test.mjs', '{root}'], expect: [/tool-output tests PASS/], needsRoot: true },
  { id: 'real/self-test', args: ['verification/real/self-test.mjs', '{root}'], expect: [/budget fake provider PASS/], needsRoot: true },
  // The host-side dispatch publication (per-attempt contexts, Transport confirmation points, ledger consumer). It boots
  // no runtime and talks to no provider: the end-to-end chain is the llm-dispatch probe, run against a patched copy.
  { id: 'real/dispatch-phase-test', args: ['verification/real/dispatch-phase-test.mjs', '{root}'], expect: [/dispatch phase tests PASS/], needsRoot: true },

  // --- P4 retention units that do not need a runs/ root ---
  { id: 'p4-retention-current', args: ['verification/unit/p4-retention-current.mjs'], expect: [/retained PASS/] },
  { id: 'p4-retention-late', args: ['verification/unit/p4-retention-late.mjs', '{root}'], expect: [/PASS/], needsRoot: true },

  // --- main regressions that need a root under runs/ (see the runs scratch note above) ---
  {
    id: 'p3-team',
    args: ['verification/integration/run.mjs', 'p3-team', '--profile', 'team', '--faults', 'all', '--root', '{root}', '--report', '{report}'],
    expect: [/p3-team: PASS/],
    needsRoot: true,
    rootBase: 'runs',
  },
  {
    id: 'p3-regressions',
    args: ['verification/integration/run.mjs', 'p3-regressions', '--profile', 'team', '--families', 'A-K', '--root', '{root}', '--report', '{report}'],
    expect: [/p3-regressions: PASS/],
    needsRoot: true,
    rootBase: 'runs',
  },
  {
    // Binds 40291/40292/40293 for the duration of the suite; the runner checks 40290-40299 are closed after it.
    id: 'p4-projections',
    args: ['verification/e2e/p4-run.mjs', 'p4-projections', '--root', '{root}', '--profile', 'team'],
    expect: [/p4-projections: PASS/],
    needsRoot: true,
    rootBase: 'runs',
    ports: true,
  },
  {
    id: 'real/full-test',
    args: ['verification/real/full-test.mjs', '{root}'],
    expect: [/PASS: .*real ledger unchanged/],
    needsRoot: true,
    rootBase: 'runs',
  },
  {
    id: 'real/collab-test',
    args: ['verification/real/collab-test.mjs', '{root}'],
    expect: [/PASS: collaboration stage offline/],
    needsRoot: true,
    rootBase: 'runs',
  },
  {
    // The opt-in performance stage's tool surface: the fake transport calls real_work brief from every study member.
    // The request catalog advertises that tool, so the study's own members must have it registered as the harness's
    // business tool; otherwise the call reaches the native effect guard and is refused as UNKNOWN_EFFECT.
    id: 'real/performance-study',
    args: ['verification/real/performance-study-test.mjs', '{root}'],
    expect: [/performance study PASS/],
    needsRoot: true,
    rootBase: 'runs',
  },
  {
    id: 'real/turn-limit-test',
    args: ['verification/real/turn-limit-test.mjs', '{root}'],
    expect: [/turn limit tests PASS/],
    needsRoot: true,
    rootBase: 'runs',
  },

  /*
   * Exclusions, and why each one is out of the offline list:
   *
   * verification/real/run.mjs <stage> --authorize-provider  (smoke, p2-replay, model-contracts, soak, collab)
   *   Live experiments. They POST to the real gateway at 127.0.0.1:<gateway-port> and bill a provider; they need
   *   CLOSEOUT_PROVIDER_KEY. Out of scope for an offline entrance.
   * verification/archive/collab-live.cjs
   *   The A/B live collaboration arms; same gateway and key requirement.
   * verification/real/dry-test.mjs
   *   Offline, but it is itself a driver: it runs the four dry stages plus their sub-suites, and full-test.mjs
   *   already invokes it as one of its steps. Running it here as well would double the work for no new signal.
   * verification/archive/p4-keepalive.mjs
   *   Drives p4-run --keep-alive and binds 40291/40292 a second time; not part of the requested regression set,
   *   and p4-projections already exercises the P4 suite entry.
   * verification/archive/p4-fixture.mjs, p4-gateway-test.mjs, p4-web.mjs, p4-fixture-plugin.mjs, p4-scenario-plugin.mjs,
   * p4-product.mjs,
   * verification/archive/p4-default-*.mjs, verification/archive/p4-soak-*.mjs, p4-ports.mjs, p4-retention-ports.mjs, p4-retention-sse.mjs,
   * verification/archive/p4-retention-trace.mjs, p4-retention-evidence.mjs, p4-retention-regressions.mjs
   *   Driver and fixture modules rather than self-contained suites: p4-web.mjs boots the product profile itself and is
   *   exercised through p4-projections (since F2a it boots the host driver - there is no switch left to choose), while
   *   the rest either need a root under runs/, an existing post-soak store, or a live host on 40290-40299.
   *   p4-ports.mjs / p4-retention-ports.mjs only assert that previously started services are closed, which would
   *   pass vacuously on an idle machine.
   * verification/p4-certificate-binding.mjs, p4-commands.mjs, p4-sequence.mjs, p3b-model.mjs, p3-tests.mjs,
   * p3b-tests.mjs, faults.mjs, host.mjs, kill-worker.mjs, fault-worker.mjs, planner-properties.mjs,
   * surface-cold.mjs, host-adapter.mjs, and the rest of verification/*.mjs
   *   Imported modules and worker/CLI helpers, not entries: run on their own they exit 0 having asserted
   *   nothing, which is exactly the "zero tests, green run" this runner must not accept.
   * verification/real/collab-watch.mjs, native-host.mjs, collab-stage.mjs, scenario.mjs, metrics.mjs, budget.mjs,
   * transport.mjs, protocol.mjs, fake.mjs, config.mjs, scope.mjs, stop.mjs, concurrency.mjs, loop-guard.mjs,
   * tool-output.mjs, protocol-metrics.mjs, collab-metrics.mjs, collab-session.mjs, collab-fake.mjs,
   * collab-snapshot-delta.mjs, cold-reader.mjs, artifact-verifier.mjs, stages.mjs, worker.mjs, run.mjs, self-test
   * helpers under collab-task/
   *   Library modules, driven by the suites above. scenario.mjs is the fixture's composition root: it boots the
   *   product profile and owns the scenarios, so the only driver is the product's; engine.mjs is gone (F2b) and
   *   verification/real is no longer exempt from the driver-surface check at the top of this list. native-host.mjs and
   *   collab-watch.mjs additionally start listener services on 40290-40299, which the runner must not leave behind.
   * verification/archive/
   *   The retired one-shot P4 scripts (p4-default-*.mjs, p4-soak-await.mjs) live here; they stay out of the
   *   suite list by definition.
   */
];