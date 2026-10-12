import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\action-fusion.mjs').href)

const captured = []
const ctx = { logger: { warn: () => {} }, on: (event, fn) => captured.push([event, fn]) }
mod.apply(ctx, {
  rules: [
    { match: 'src/', command: 'node -e console.log(42)', timeoutMs: 20000 },
    { match: 'fail/', command: 'node -e process.exit(3)', timeoutMs: 20000 },
  ],
  shell: 'none',
  cwd: 'D:\\dsh-test\\workspaces\\test',
})
assert.equal(captured.length, 1, 'exactly one listener')
assert.equal(captured[0][0], 'tools/post-execute')
const listener = captured[0][1]

const execFor = (name, file) => ({ name, arguments: { file_path: file }, agent: {} })
const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'edited' }] }
const accept = async () => ({ kind: 'accept' })

const cases = []
const run = async (label, exec, res, next) => {
  const out = await listener(exec, res, next)
  cases.push({ label, out })
}

await run('non-mutating tool passes through', execFor('read', 'D:\\p\\src\\a.ts'), result, accept)
await run('non-matching path passes through', execFor('edit', 'D:\\p\\other\\a.ts'), result, accept)
await run('matching path fuses validation (pass)', execFor('edit', 'D:\\p\\src\\ui\\a.ts'), result, accept)
await run('failing command still fuses output', execFor('write', 'D:\\p\\fail\\a.ts'), result, accept)
await run('errored result passes through', execFor('edit', 'D:\\p\\src\\a.ts'), { isError: true, content: [] }, accept)
await run('downstream block passes through', execFor('edit', 'D:\\p\\src\\a.ts'), result, async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))

let failed = 0
const check = (label, cond, detail) => {
  if (!cond) failed++
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : ''))
}

const [c1, c2, c3, c4, c5, c6] = cases
check('non-mutating tool passes through', c1.out === undefined || (c1.out.kind === 'accept' && c1.out.content === undefined))
check('non-matching path passes through', c2.out.content === undefined)
check('matching path appends one block', Array.isArray(c3.out.content) && c3.out.content.length === 2, 'len=' + (c3.out.content || []).length)
check('fused block reports PASS', /\[action-fusion\] PASS/.test(c3.out.content?.[1]?.text || ''), JSON.stringify(c3.out.content?.[1]?.text?.slice(0, 80)))
check('fused block carries command output', /(^|\n)42\s*$/.test(c3.out.content?.[1]?.text || ''))
check('value is preserved by the decision', c3.out.value === undefined, 'registry keeps result.value when decision omits it')
check('failing command fuses FAIL(exit 3)', /\[action-fusion\] FAIL\(exit 3\)/.test(c4.out.content?.[1]?.text || ''), JSON.stringify(c4.out.content?.[1]?.text?.slice(0, 80)))
check('errored result passes through', c5.out.content === undefined)
check('downstream block passes through unchanged', c6.out.kind === 'block' && !Object.hasOwn(c6.out, 'content'))

console.log('---')
console.log('total=' + (9) + ' failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
