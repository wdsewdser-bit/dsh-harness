# Isolated optional tool runtime

This directory pins the four missing browser/computer packages to the installed host's `0.1.7-rc.2`. It does not modify production or the shared `node_modules` directory. The lockfile pins transitive package integrity. Installation used `--ignore-scripts --legacy-peer-deps --no-audit --no-fund`.

Reproduce the installation here with:

```powershell
npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund --registry=https://registry.npmjs.org
```

For an explicitly isolated host process, preload `resolve.mjs` instead of the normal canonical test preload. Pass it as a process argument, not `NODE_OPTIONS`, so it does not leak into every subprocess:

```powershell
node --preserve-symlinks --preserve-symlinks-main --import ./optional-tools-runtime-20261017/resolve.mjs D:/dsh-test/output/system-runtime-fixes-20261017/optional-tools-smoke.mjs
```

The resolver retains staged native aliases. It first resolves every other DeepSeek SDK from the host, then permits only the four optional packages and their browser resource runtime to fall back to this directory. Third-party packages use normal Node resolution. It does not substitute duplicate framework/core instances or install globally.

The native smoke mounts both real capability registries and both real providers. It uses a dummy Stagehand model key only for non-AI browser calls, opens its own headless browser, navigates to its own local HTTP page, captures an image, queries desktop permissions without screenshots/input, and disposes its resources. It does not use real model credentials, call AI act/observe/extract, or exercise desktop input.

Production remains unchanged. Before any later authorized deployment, migrate the existing Stagehand configuration to this version's schema: `model.apiKey` is required; `apiKeyEnv` and custom `baseURL` are not fields of this pinned provider's model schema. Preserve the authorized model/provider and credential boundaries; do not silently change providers or persist keys in artifacts. The offline model fixture is not a production configuration. Package loading and native navigation do not establish AI inference compatibility.
