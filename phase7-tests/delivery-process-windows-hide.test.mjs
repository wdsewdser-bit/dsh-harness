import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const worktree = await import('../home/profiles/web/plugins/team-worktree.mjs')
const tools = await import('../home/profiles/web/plugins/team-tools-v2-r10.mjs')

test('delivery Git and Cargo child processes stay hidden with unchanged command and result semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delivery-hide-'))
  assert.equal(resolve(dirname(root)), resolve(tmpdir()))
  const calls = []
  let behavior = () => 'ok\n'
  const stub = mock.method(childProcess, 'execFileSync', (file, args, options) => {
    calls.push({ file, args, options })
    assert.equal(options.windowsHide, true)
    assert.equal(options.encoding, 'utf8')
    assert.equal(options.timeout, 120000)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.shell, undefined)
    return behavior(file, args, options)
  })
  syncBuiltinESMExports()
  const failure = (status, stdout, stderr) => Object.assign(new Error('fixture failure'), { status, stdout, stderr })
  const commit = 'a'.repeat(40)
  try {
    behavior = () => commit + '\n'
    assert.deepEqual(worktree.runGit(root, ['rev-list', 'main']), { code: 0, stdout: commit + '\n', stderr: '' })
    assert.equal(tools.mainAncestorSet(root).has(commit), true)
    assert.equal(tools.taskIntegrationVerdict({ status: 'completed', workKind: 'edit', commitSha: commit }, root).state, 'integrated-pending-terminal')
    behavior = () => { throw failure(1, 'out', 'not ancestor') }
    assert.equal(tools.taskIntegrationVerdict({ status: 'completed', workKind: 'edit', commitSha: commit }, root).state, 'completed-not-integrated')
    behavior = () => { throw failure(7, 'out', 'err') }
    assert.deepEqual(worktree.runGit(root, ['rev-list', 'main']), { code: 7, stdout: 'out', stderr: 'err' })
    const beforeOverride = calls.length
    assert.equal(worktree.runGit(root, ['status'], () => ({ code: 9 })).code, 9)
    assert.equal(calls.length, beforeOverride)

    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n')
    const child = join(root, 'child')
    mkdirSync(child)
    writeFileSync(join(child, 'Cargo.toml'), '[workspace]\n')
    behavior = (_file, _args, options) => JSON.stringify({ target_directory: join(options.cwd, 'isolated-target') })
    assert.equal(worktree.cargoTargetDirectory(root).targetDirectory, resolve(root, 'isolated-target'))
    assert.equal(worktree.cargoTargetIsolationVerdict([{ id: 'root', path: root }, { id: 'child', path: child }]).ok, true)
    behavior = () => { throw failure(8, '', 'cargo failed') }
    assert.equal(worktree.cargoTargetDirectory(root).code, 'cargo-metadata-failed')
    behavior = () => '{invalid'
    assert.equal(worktree.cargoTargetDirectory(root).code, 'cargo-metadata-invalid')

    assert.equal(calls.filter(call => call.file === 'git').length, 5)
    assert.equal(calls.filter(call => call.file === 'cargo').length, 5)
    assert.deepEqual(calls.filter(call => call.file === 'git').map(call => call.args), [
      ['rev-list', 'main'], ['rev-list', 'main'],
      ['merge-base', '--is-ancestor', commit, 'main'],
      ['merge-base', '--is-ancestor', commit, 'main'], ['rev-list', 'main'],
    ])
    assert.ok(calls.filter(call => call.file === 'cargo').every(call =>
      JSON.stringify(call.args) === JSON.stringify(['metadata', '--no-deps', '--format-version', '1', '--manifest-path', join(call.options.cwd, 'Cargo.toml')]))
    )
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
