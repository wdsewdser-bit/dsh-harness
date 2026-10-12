# DSH 0.1.7-rc.2 Upgrade Handoff

## Conclusion

`D:\dsh-test` is now upgraded from `0.1.7-rc.1` to `0.1.7-rc.2`.
The installed desktop app is also `0.1.7-rc.2`, so it can safely share
`D:\dsh-test\home` through the `profiles/desktop` junction to `profiles/web`.

The desktop launcher now has a hard version gate. It refuses to start when
the desktop app and the test runtime differ.

## Backup And Rollback

Latest backup path:

```text
D:\dsh-test\backup-rc2-20260925-082539
D:\dsh-test\backup-rc2-latest.txt
```

The backup contains `app`, `profiles/web`, `profiles/headless`, the three
launchers, and the original user-level `DSH_HOME` value.

Rollback must restore the app and both profiles together. Do not mix rc1
and rc2 trees.

## Actual Changes

- `app/package.json`: `@deepseek-ai/dsh` is `0.1.7-rc.2`.
- `app/pnpm-workspace.yaml`: all DSH package excludes are rc2; added
  `nodeLinker: hoisted` so direct test harness imports resolve like the
  previous local layout.
- `profiles/web/package.json` and `profiles/headless/package.json`:
  direct plugin versions are rc2.
- Both profiles now declare the core peer packages used by local plugin
  files as dev dependencies, so direct `node --test` runs do not need an
  external resolver shim.
- Rebuilt or renamed persistent patch keys/files to rc2:
  - agent-team profile
  - agent-team domain
  - client UI agent-team
  - Stagehand native
  - pi-ai
  - session format v0-to-v1
  - session format v3-to-v4
  - session persistence JSONL
- Stagehand rc2 changed its `package.json` dependency ordering. The rc2
  patch has a corrected final hunk and passes `git apply --check`.
- The session persistence JSONL patch moved to the rc2 hunk location and
  now installs without pnpm's patch-offset failure.
- `profiles/web/cordis.patch.yml` now targets
  `@deepseek-ai/dsh-llm-deepseek-api-key`; rc2 renamed the active plugin
  from `@deepseek-ai/dsh-llm-deepseek`.
- Added `tools/check-dsh-desktop-version.ps1` and
  `tools/read-dsh-desktop-version.cjs`.
- Updated `start-dsh-desktop-test.bat` to fail closed on a version mismatch.

## Verification

- `web --dump-config`: exit 0.
- `headless --dump-config`: exit 0.
- `home/compatibility-health.json`: `ready:true`, `failures:[]`,
  `inactive:[]`; all 12 required capabilities are active.
- `home/team-health-web.json`: status healthy; Team, Room, operator,
  write-scope, compaction, and v12 runtime modules are enabled.
- Full local regression:
  `phase1` through `phase9` passed `95/95`.
- Desktop version gate: `0.1.7-rc.2` local and desktop, gate passed.
- Test web instance was stopped after validation; no DSH test server is
  left running.

## Operational Notes

- Start the normal test web instance with `D:\dsh-test\start-dsh-test.bat`.
- Start the desktop app with `D:\dsh-test\start-dsh-desktop-test.bat`.
- Do not launch the desktop app against a future desktop update until the
  local test runtime is upgraded and the version gate passes.
- The Stagehand configuration continues to use the official DeepSeek
  Anthropic-compatible endpoint:
  `https://api.deepseek.com/anthropic`.
