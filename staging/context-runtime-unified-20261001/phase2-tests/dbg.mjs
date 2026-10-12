import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\action-fusion.mjs').href)
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

