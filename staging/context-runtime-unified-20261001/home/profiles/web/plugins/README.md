# Web search fix (opencode.ai Zen Go session header)

## Symptom

The `web_search` tool failed on every call with:

    DeepSeek API error (HTTP 400): Error from provider (Console Go):
    Request is missing x-opencode-session and cannot be routed efficiently.

`web_fetch` kept working, so network egress was never the problem.

## Root cause

The endpoint configured in `~/.dsh/settings.yaml`
(`web-search-deepseek.baseURL: https://opencode.ai/zen/go/v1`) is the
opencode.ai Zen Go gateway, which requires an `x-opencode-session` header on
`POST /messages`.

The shipped provider `@deepseek-ai/dsh-web-search-deepseek` sends only
`x-api-key`, `authorization`, `anthropic-version`, `content-type`, `accept` and
`user-agent` (see its `lib/index.js`), and its config schema exposes no
custom-header option. Every search therefore returned HTTP 400.

## Fix

Two files, both user-level (nothing under `/usr/lib/node_modules` was modified):

1. `opencode-search.mjs` — a local provider speaking the same
   Anthropic-compatible Messages protocol with the `web_search_20250305` server
   tool, registering under the id `opencode-zen` and adding the
   `x-opencode-session` header.
   Endpoint, model, credential reference and use limits are read from the
   existing `web-search-deepseek` settings section first, so
   Settings > Plugins > Plugin configuration still controls them. The credential
   is resolved through the credentials service (`OPENCODEGO_API_KEY`), with the
   launching environment as fallback.
2. `../cordis.patch.yml` — inserts the plugin row and points `ctx.web` at it
   (`searchProvider: opencode-zen`, `fetchProvider: http` unchanged).

The web profile sets `patchReload: "live"`, so the fix applies without a
restart and also composes on the next boot (verified with `dsh --profile web
--dump-config`).

## Verified

- Standalone provider call returned 10 sources.
- Live `web_search` through the running harness returned 8 sources.
- Multi-query search, `web_fetch`, and repeated patch reloads still work.

## Revert

Restore `../cordis.patch.yml` from `../cordis.patch.yml.pre-websearch-fix`
(its original content was `[]`) and delete this directory. Reverting brings back
the HTTP 400 unless the endpoint is changed to one that does not require the
header, or the shipped provider gains header support.

## Note

The shipped `web-search-deepseek` provider stays registered but unused while
`web.searchProvider` is `opencode-zen`. If a future release adds configurable
headers, remove this override.
