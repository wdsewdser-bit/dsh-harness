import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:\\dsh-test\\workspaces\\test'
for (const d of ['src\\ui', 'src\\ai', 'src\\ui-evil', 'assets\\mat']) mkdirSync(resolve(ROOT, d), { recursive: true })

const scopesPath = 'D:\\dsh-test\\phase1-tests\\scopes.fixture.json'
writeFileSync(scopesPath, JSON.stringify({
  rootDir: ROOT,
  defaultDeny: false,
  bySession: { 'sess-ui': ['src/ui'], 'sess-star': '*', 'sess-empty': [] },
  byName: { 'named-ai': ['src/ai'] },
}))

const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\write-scope-guard.mjs').href)

const registered = []
const ctx = {
  logger: { warn: (m) => registered.push(['warn', m]) },
  on: (event, listener, options) => registered.push([event, listener, options]),
}

mod.apply(ctx, { scopesFile: scopesPath, enforce: true })

const listeners = {}
for (const row of registered) {
  if (typeof row[0] === 'string' && typeof row[1] === 'function') listeners[row[0]] = { fn: row[1], opts: row[2] }
}
assert.ok(listeners['fs/write-intent'], 'write-intent listener missing')
assert.ok(listeners['fs/edit-intent'], 'edit-intent listener missing')
assert.equal(listeners['fs/write-intent'].opts && listeners['fs/write-intent'].opts.prepend, true, 'must prepend to beat the observation policy')

const actor = (sessionId, name) => ({ agent: { name: name, session: { id: sessionId } } })
const target = (p) => ({ displayPath: p, targetKey: resolve(p) })

const cases = []
const run = (label, eventName, tgt, act, expect) => {
  let outcome = 'allowed'
  let code = null
  try {
    const v = listeners[eventName].fn(tgt, act)
    outcome = v === undefined ? 'allowed' : 'returned-intent'
  } catch (err) {
    outcome = 'threw'
    code = err && err.code ? err.code : null
  }
  cases.push({ label, outcome, code, expect })
}

run('in-scope write', 'fs/write-intent', target(ROOT + '\\src\\ui\\button.tsx'), actor('sess-ui'), 'allowed')
run('out-of-scope write', 'fs/write-intent', target(ROOT + '\\src\\ai\\brain.ts'), actor('sess-ui'), 'threw:FS_WRITE_OUT_OF_SCOPE')
run('sibling-prefix evasion (src/ui-evil)', 'fs/write-intent', target(ROOT + '\\src\\ui-evil\\x.ts'), actor('sess-ui'), 'threw:FS_WRITE_OUT_OF_SCOPE')
run('traversal evasion (..\\ai)', 'fs/write-intent', target(ROOT + '\\src\\ui\\..\\ai\\x.ts'), actor('sess-ui'), 'threw:FS_WRITE_OUT_OF_SCOPE')
run('wildcard scope passes', 'fs/write-intent', target(ROOT + '\\assets\\mat\\a.txt'), actor('sess-star'), 'allowed')
run('empty scope denies', 'fs/write-intent', target(ROOT + '\\src\\ui\\a.ts'), actor('sess-empty'), 'threw:FS_WRITE_OUT_OF_SCOPE')
run('undeclared member passes when defaultDeny=false', 'fs/write-intent', target(ROOT + '\\src\\ai\\a.ts'), actor('sess-other'), 'allowed')
run('byName scope enforced', 'fs/edit-intent', target(ROOT + '\\assets\\mat\\a.txt'), actor('sess-x', 'named-ai'), 'threw:FS_WRITE_OUT_OF_SCOPE')
run('in-scope edit allowed', 'fs/edit-intent', target(ROOT + '\\src\\ui\\a.ts'), actor('sess-ui'), 'allowed')
run('no-actor call passes', 'fs/write-intent', target(ROOT + '\\src\\ai\\a.ts'), undefined, 'allowed')

let failed = 0
for (const c of cases) {
  const actual = c.outcome === 'threw' ? 'threw:' + c.code : c.outcome
  const ok = actual === c.expect
  if (!ok) failed++
  console.log((ok ? 'PASS ' : 'FAIL ') + c.label + '  expected=' + c.expect + ' actual=' + actual)
}
console.log('---')
console.log('total=' + cases.length + ' failed=' + failed)
rmSync(scopesPath, { force: true })
process.exit(failed === 0 ? 0 : 1)
