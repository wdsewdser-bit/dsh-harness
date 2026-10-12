import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\observation-pack.mjs').href)
const spillDir = 'D:\\dsh-test\\phase2-tests\\spill'
rmSync(spillDir, { recursive: true, force: true })

const cap = new Map()
const ctx = { logger: { warn: () => {} }, on: (e, f) => cap.set(e, f) }
mod.apply(ctx, { maxInlineChars: 100, previewChars: 40, spillDir })
assert.ok(cap.has('tools/post-execute'), 'post-execute listener')
assert.ok(cap.has('tools/ptc-dispatch-log'), 'ptc listener')

const big = 'X'.repeat(5000) + '\nEND-MARKER'
const small = 'tiny'
const accept = async () => ({ kind: 'accept' })

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')) }

// 1. small observation passes through untouched
const a = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, value: 1, content: [{ type: 'text', text: small }] }, accept)
check('small observation untouched', a.content === undefined)

// 2. large observation becomes a handle
const b = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, value: { code: 0 }, content: [{ type: 'text', text: big }] }, accept)
check('large observation replaced by one handle', Array.isArray(b.content) && b.content.length === 1 && b.content[0].type === 'text')
check('handle omits the payload', !(b.content[0].text.includes('END-MARKER')), 'preview-only')
check('handle states the original size', /chars=5011/.test(b.content[0].text), b.content[0].text.split('\n')[0])
const pathLine = (b.content[0].text.match(/full output: (.+)/) || [])[1]
check('handle carries an absolute path', !!pathLine && pathLine.includes('obs-'), String(pathLine))
check('spilled file exists', !!pathLine && existsSync(pathLine.trim()))
check('spilled file is byte-complete', !!pathLine && readFileSync(pathLine.trim(), 'utf8') === big)
check('value is preserved (decision omits value)', !Object.hasOwn(b, 'value'))

// 3. error results are never packed
const c = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: true, content: [{ type: 'text', text: big }] }, accept)
check('errored result untouched', c.content === undefined)

// 4. block decisions are never repacked
const d = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, content: [{ type: 'text', text: big }] }, async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))
check('block decision untouched', d.kind === 'block')

// 5. ptc sub-dispatch packing
const e = await cap.get('tools/ptc-dispatch-log')({ name: 'bash', isError: false }, async () => [{ type: 'text', text: big }])
check('ptc large dispatch packed', e.length === 1 && /\[observation-pack\]/.test(e[0].text))
const f = await cap.get('tools/ptc-dispatch-log')({ name: 'bash', isError: false }, async () => [{ type: 'text', text: small }])
check('ptc small dispatch untouched', f.length === 1 && f[0].text === small)

// 6. allow-list honors config
cap.clear()
mod.apply(ctx, { maxInlineChars: 100, previewChars: 40, spillDir, tools: ['read'] })
const g = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, content: [{ type: 'text', text: big }] }, accept)
check('tool outside allow-list untouched', g.content === undefined)

console.log('---')
console.log('total=12 failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
