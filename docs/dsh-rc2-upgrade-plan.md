# DSH 0.1.7-rc.1 -> 0.1.7-rc.2 Upgrade Plan

Status: complete. See `dsh-rc2-upgrade-handoff.md` for the applied changes,
verification evidence, and rollback path.

Scope: `D:\dsh-test` only. Production `D:\dsh` is not changed.

## Goal

Upgrade the test runtime and both profiles to `0.1.7-rc.2`, rebuild every
local persistent patch against the rc2 sources, and make the installed
desktop app safely share `D:\dsh-test\home`.

The desktop app is already `0.1.7-rc.2`. It must not be allowed to start
against the rc1 profile because rc2 disables incompatible Team, browser,
computer-use, and pi-ai plugins.

## Version Facts

- Installed desktop app: `@deepseek-ai/dsh-desktop@0.1.7-rc.2`.
- Current test CLI: `@deepseek-ai/dsh@0.1.7-rc.1`.
- Current web/headless profiles: `0.1.7-rc.1`.
- Official release: `dsh-v0.1.7-rc.2`, published 2026-09-24.
- rc2 keeps the same 0.1.7 profile layout. Main changes are desktop
  onboarding/background tasks, shortcuts, plugin recovery, long-output and
  long-conversation fixes, and reduced fixed instruction overhead.

## Required Changes

1. Back up `app`, `profiles/web`, `profiles/headless`, and the launchers.
2. Replace every DSH monorepo package version `0.1.7-rc.1` with
   `0.1.7-rc.2` in the app and profile manifests, locks, workspace excludes,
   and patch keys.
3. Rebuild and verify these persistent patches against rc2:
   - `dsh-experimental-agent-team`
   - `dsh-experimental-client-ui-agent-team`
   - `dsh-experimental-browser-use-stagehand-native`
   - `dsh-llm-pi-ai`
   - app session compatibility patches
4. Preserve Team/Room/board behavior, Stagehand Anthropic-compatible
   provider support, CUA support, and pi-ai `in-history` cache behavior.
5. Install the app, web profile, and headless profile with pnpm.
6. Add a desktop launcher version gate. It must refuse to launch when the
   desktop version differs from the test CLI version.
7. Verify compatibility before allowing normal desktop use:
   - app/web/headless `--dump-config` exits 0 without loader errors
   - `home/compatibility-health.json` has `ready:true`
   - Team, Room, Stagehand, CUA, write-scope, compaction, and operator
     plugins are active
   - no rc1 package remains in the active app/profile trees
   - desktop host starts with `DSH_HOME=D:\dsh-test\home`
   - existing test sessions and Team panels can be opened

## Rollback

The latest full backup path is written to:

```text
D:\dsh-test\backup-rc2-latest.txt
```

Rollback must restore `app`, both profiles, and launchers together. Session
data is not migrated in this patch-level upgrade, but the profile trees must
not be mixed across versions.

## Acceptance Rule

Do not call the upgrade complete merely because a port opens. Completion
requires the compatibility health file to be ready and the desktop version
gate to pass. Until then, the desktop launcher must fail closed with a clear
message.
