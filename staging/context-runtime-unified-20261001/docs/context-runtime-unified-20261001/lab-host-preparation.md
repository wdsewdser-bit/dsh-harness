# Isolated Lab Host Preparation

Preparation entry: `node tools/prepare-unified-lab-host.mjs`. This composes a web host from the existing headless Team overrides, remaps state under `lab-host-home`, dumps config and imports the native module graph without starting a host or requesting a provider.

Use `lab-host-home/preparation-evidence.json` for the exact PowerShell `startCommand`. Root must choose an unused port and provide existing authentication read-only before startup. Never use production launch-dsh-test.cjs.

The command requires both symlink preservation flags plus `--import file:///.../tools/prepare-unified-lab-host.mjs` and `DSH_LAB_CANONICAL_MODULES=1`. The import installs a bare-package resolver anchored at stage app/package.json; this avoids production resolution and duplicate profile/native module identities. The virtual package anchor need not exist. `module-graph.json` records actual imports, not just source hashes.

State is isolated under lab-host-home. Root and profile patches are structurally remapped and checked before writing, then the composed dump is checked again. Context workspace starts shadow with empty appliedSessionIds; Window, Instant and Reducer entries are disabled. The only allowed production file references are the exact compatibility manifest and credentialsFile=.credentials.yaml; no credentials are copied. The old usage-history identity path is remapped into the lab reports tree, so production history identity is not consumed. Absence remains unknown to the ledger. YAML dump expressions are parsed as inert values for path inspection.

The loader explicitly maps @deepseek-ai/dsh-tool-goal to stage app/node_modules/@deepseek-ai/dsh-tool-goal-v15/lib/index.js. module-graph.json captures the actual loaded alias URL and exported function implementation hashes; an unmapped old alias is rejected. Native work may still change this implementation: root must rerun prepare after native stabilization.

Stage team-roles/identity-version.json v15 identity and its five declared text files are hash-checked before copying to lab-host-home/team-roles. preparation-evidence.json records the verified version and per-file hashes. Role configuration consumes the lab directory. This checks delivered files, not an assembled agent prompt.

Validation covers configuration composition, configured write paths and native module loading. It does not verify plugin mount, HTTP readiness, relative persona data files, credentials or loaded agent certificates; those require the root's authorized isolated startup. Disk config and module imports are not live PTC certificates.
