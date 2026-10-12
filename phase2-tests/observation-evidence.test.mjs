import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\observation-pack.mjs').href)
const spillDir = 'D:\\dsh-test\\phase2-tests\\spill2'
rmSync(spillDir, { recursive: true, force: true })
const cap = new Map()
mod.apply({ logger: { warn: () => {} }, on: (e, f) => cap.set(e, f) }, { maxInlineChars: 100, previewChars: 30, spillDir, evidenceChars: 400 })

const bulk = Array.from({ length: 300 }, (_, i) => 'noise line ' + i + ' ' + 'z'.repeat(30)).join('\n')
const text = bulk + '\nERROR: cannot resolve module ./missing at step 7\n' + bulk + '\nFAIL src/ui/button.test.tsx > renders <button>\n' + bulk
const accept = async () => ({ kind: 'accept' })
const out = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, content: [{ type: 'text', text }] }, accept)
const handleText = out.content[0].text

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')) }

check('handle is compact vs original', handleText.length < text.length / 4, handleText.length + ' < ' + text.length)
check('decisive ERROR line retained', handleText.includes('ERROR: cannot resolve module ./missing at step 7'))
check('decisive FAIL line retained', handleText.includes('FAIL src/ui/button.test.tsx'))
check('evidence section labelled', handleText.includes('--- evidence lines (always retained) ---'))
check('noise lines are not retained wholesale', !handleText.includes('noise line 250'), 'evidence selection, not full copy')
const pathLine = (handleText.match(/full output: (.+)/) || [])[1]
check('spill is still byte-complete', !!pathLine && readFileSync(pathLine.trim(), 'utf8') === text)
check('evidence budget respected', handleText.split('--- evidence lines (always retained) ---')[1].length < 700, String(handleText.split('--- evidence lines (always retained) ---')[1].length))

// config override of the pattern
cap.clear()
mod.apply({ logger: { warn: () => {} }, on: (e, f) => cap.set(e, f) }, { maxInlineChars: 100, previewChars: 30, spillDir, evidencePattern: 'ZZZ_CUSTOM', evidenceChars: 200 })
const out2 = await cap.get('tools/post-execute')({ name: 'bash' }, { isError: false, content: [{ type: 'text', text: text + '\nZZZ_CUSTOM hit' }] }, accept)
check('custom evidencePattern honored', out2.content[0].text.includes('ZZZ_CUSTOM hit') && !out2.content[0].text.includes('--- evidence'.replace('--- ', '')+' lines (always retained) ---\nnoise') )
check('default pattern not applied when overridden', !out2.content[0].text.includes('ERROR: cannot resolve module'))

console.log('---')
console.log('total=9 failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
