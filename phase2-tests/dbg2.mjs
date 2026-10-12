import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const src = readFileSync('D:\\dsh-test\\home\\profiles\\web\\plugins\\action-fusion.mjs', 'utf8')
const patched = src
  .replace('if (rules.length === 0) return downstream', "console.log('DBG rules', rules.length); if (rules.length === 0) return downstream")
  .replace('if (!exec || !MUTATING.has(exec.name)) return downstream', "console.log('DBG name', exec && exec.name, exec && Object.keys(exec.arguments||{}), exec && exec.arguments && exec.arguments.file_path); if (!exec || !MUTATING.has(exec.name)) return downstream")
  .replace('if (!result || result.isError === true) return downstream', "console.log('DBG result', result && result.isError); if (!result || result.isError === true) return downstream")
  .replace('if (!rule) return downstream', "console.log('DBG rule', rule && rule.command); if (!rule) return downstream")
  .replace('const outcome = await runCommand(rule, cwd, shell, defaultTimeoutMs)', "console.log('DBG running', JSON.stringify({cwd, shell, defaultTimeoutMs})); const outcome = await runCommand(rule, cwd, shell, defaultTimeoutMs); console.log('DBG outcome', JSON.stringify(outcome).slice(0,200))")
writeFileSync('D:\\dsh-test\\phase2-tests\\dbg-plugin.mjs', patched)
const mod = await import(pathToFileURL('D:\\dsh-test\\phase2-tests\\dbg-plugin.mjs').href)
const cap = []
mod.apply({ logger: { warn: (m) => console.log('WARN', m) }, on: (e, f) => cap.push(f) }, {
  rules: [{ match: 'src/', command: 'node -e console.log(42)', timeoutMs: 20000 }],
  shell: 'none',
  cwd: 'D:\\dsh-test\\workspaces\\test',
})
const exec = { name: 'edit', arguments: { file_path: 'D:\\p\\src\\ui\\a.ts' }, agent: {} }
const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'edited' }] }
const out = await cap[0](exec, result, async () => ({ kind: 'accept' }))
console.log('OUT=', JSON.stringify(out))

