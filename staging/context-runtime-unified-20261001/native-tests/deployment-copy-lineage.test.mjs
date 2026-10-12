import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const sha = value => createHash('sha256').update(value).digest('hex').toUpperCase()
function fixture(t, { unknownCopy = false, history = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'window-deploy-lineage-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stage = join(root, 'staging/unified'), tools = join(stage, 'tools')
  mkdirSync(tools, { recursive: true }); mkdirSync(join(stage, 'home/team-roles'), { recursive: true })
  const tool = join(tools, 'deploy-production.mjs')
  copyFileSync(new URL('../tools/deploy-production.mjs', import.meta.url), tool)
  const target = 'app/node_modules/@deepseek-ai/window-fixture/lib/index.js'
  const source = join(stage, target), current = 'previous deployed content', next = 'new stage content'
  for (const directory of ['app', 'home/profiles/web', 'home/profiles/headless']) {
    const pkg = join(root, directory, 'node_modules/@deepseek-ai/window-fixture')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/window-fixture', version: '1.0.0' }))
    writeFileSync(join(pkg, 'lib/index.js'), unknownCopy && directory.includes('headless') ? 'unrelated edit' : current)
  }
  mkdirSync(join(source, '..'), { recursive: true }); writeFileSync(source, next)
  writeFileSync(join(stage, 'native-change-manifest.json'), JSON.stringify([{ package: 'window-fixture', path: source,
    before: sha('original package'), after: sha(next) }]))
  writeFileSync(join(stage, 'plugin-change-manifest.json'), '[]')
  const previous = join(root, 'previous'); mkdirSync(previous)
  writeFileSync(join(previous, 'deploy-backup.json'), JSON.stringify({ files: history ? [{ target, afterSha256: sha(current) }] : [] }))
  return { tool, root, previous }
}
const plan = f => spawnSync(process.execPath, [f.tool, '--plan', '--previous', f.previous], { cwd: f.root, encoding: 'utf8', windowsHide: true })

test('a physical copy accepts only the canonical hash recorded by a prior deploy', t => {
  const result = plan(fixture(t))
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.problems, [])
  assert.equal(report.toWrite, 3)
  assert.equal(report.byGroup['native-copy'].replace, 2)
})

test('canonical lineage cannot authorize an unrelated copy edit', t => {
  const result = plan(fixture(t, { unknownCopy: true }))
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0], /drifted: home\/profiles\/headless/)
})

test('the same current files without a prior deployment record remain refused', t => {
  const result = plan(fixture(t, { history: false }))
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).problems.length, 3)
})
