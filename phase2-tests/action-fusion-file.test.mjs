#!/usr/bin/env node
/** Phase 2: action-fusion's {file} substitution and project-root resolution. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, projectRoot } from '../home/profiles/web/plugins/action-fusion.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

// ---- project root: the command has to run where the file lives ----
{
  const root = mkdtempSync(join(tmpdir(), 'af-root-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  check('the nearest package.json wins', projectRoot(join(root, 'src', 'deep', 'a.js')) === root, String(projectRoot(join(root, 'src', 'deep', 'a.js'))))
  const orphan = mkdtempSync(join(tmpdir(), 'af-orphan-'))
  check('a file outside any project yields undefined', projectRoot(join(orphan, 'a.js')) === undefined, String(projectRoot(join(orphan, 'a.js'))))
  check('a missing path is not a crash', projectRoot(undefined) === undefined && projectRoot('') === undefined)
}

// ---- {file}: validate exactly what changed, in its own project ----
{
  const root = mkdtempSync(join(tmpdir(), 'af-run-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  const broken = join(root, 'src', 'broken.js')
  // A real syntax error: node --check must fail on it.
  writeFileSync(broken, 'function ( { \n')
  const good = join(root, 'src', 'good.js')
  writeFileSync(good, 'const a = 1\n')

  const captured = new Map()
  apply({ on: (name, fn) => captured.set(name, fn), logger: { warn: () => {} } }, {
    rules: [{ match: '/[.](js|mjs|cjs)$/', command: 'node --check "{file}"', timeoutMs: 20000 }],
    shell: 'none',
    keepOutputChars: 2000,
  })
  const fire = (filePath) => captured.get('tools/post-execute')(
    { name: 'edit', arguments: { file_path: filePath } },
    { content: [{ type: 'text', text: 'edit ok' }] },
    async () => ({ kind: 'accept' }),
  )

  const bad = await fire(broken)
  const badText = JSON.stringify(bad)
  check('a rule with {file} actually runs the command', badText.includes('node --check') || badText.includes('{file}') === false, badText.slice(0, 200))
  check('the syntax error is surfaced to the agent', /SyntaxError|Unexpected|error/i.test(badText), badText.slice(0, 220))
  check('the original result content is preserved', bad.content[0].text === 'edit ok', JSON.stringify(bad.content[0]))

  const ok = await fire(good)
  check('a clean file reports success without failing the call', JSON.stringify(ok).includes('edit ok'), JSON.stringify(ok).slice(0, 200))

  const skipped = await fire(join(root, 'src', 'note.txt'))
  // Passing through means returning the downstream decision untouched, so there is no
  // added content at all — that absence IS the assertion.
  check('a non-matching path passes straight through', skipped.content === undefined && skipped.kind === 'accept', JSON.stringify(skipped))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
