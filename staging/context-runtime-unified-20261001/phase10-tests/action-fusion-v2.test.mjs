import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  projectRoot,
  resolveCommandContext,
  substituteCommand,
} from '../home/profiles/web/plugins/action-fusion-v2.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af2-'))
  const crate = join(root, 'crate-a')
  const src = join(crate, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["crate-a"]\n')
  writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "crate-a"\nversion = "0.1.0"\nedition = "2021"\n')
  const file = join(src, 'lib.rs')
  writeFileSync(file, 'pub fn a() {}\n')
  return { root, crate, file }
}

function harness(rules, telemetryDir, extra = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on(name, fn) {
      listeners.set(name, fn)
    },
  }
  apply(ctx, { rules, keepOutputChars: 4000, crateCooldownMs: 0, telemetryDir, ...extra })
  return listeners.get('tools/post-execute')
}

test('rust context resolves the workspace root and crate name', () => {
  const fx = fixture()
  try {
    assert.equal(projectRoot(fx.file), fx.crate)
    const context = resolveCommandContext({}, fx.file, 'C:\\fallback')
    assert.equal(context.cwd, fx.root)
    assert.equal(context.crate, 'crate-a')
    assert.equal(context.project, fx.crate)
    assert.equal(
      substituteCommand('cargo check -p {crate} --manifest-path {project}/Cargo.toml', context, fx.file),
      `cargo check -p crate-a --manifest-path ${fx.crate}/Cargo.toml`,
    )
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('fusion appends one validation block and deduplicates identical content', async () => {
  const fx = fixture()
  try {
    const listener = harness([
      {
        match: '/[.](rs)$/',
        command: 'node -e "process.exit(0)"',
        shell: 'none',
        timeoutMs: 20000,
      },
    ], fx.root)
    const exec = { name: 'edit', arguments: { file_path: fx.file } }
    const result = { isError: false, content: [{ type: 'text', text: 'edited' }] }
    const next = async () => ({ kind: 'accept' })

    const first = await listener(exec, result, next)
    assert.equal(first.content.length, 2)
    assert.match(first.content[1].text, /^\[action-fusion\] PASS :: node -e/)

    const second = await listener(exec, result, next)
    assert.equal(second.content, undefined)

    writeFileSync(fx.file, 'pub fn a() { let _ = 1; }\n')
    const third = await listener(exec, result, next)
    assert.equal(third.content.length, 2)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a crate-scoped rule is skipped when no Cargo.toml exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af2-nocrate-'))
  try {
    const file = join(root, 'loose.rs')
    writeFileSync(file, 'pub fn a() {}\n')
    const listener = harness([
      {
        match: '/[.](rs)$/',
        command: 'cargo check -p {crate}',
        shell: 'none',
        timeoutMs: 20000,
      },
    ], root)
    const decision = await listener(
      { name: 'edit', arguments: { file_path: file } },
      { isError: false, content: [{ type: 'text', text: 'edited' }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.content, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed edits and non-mutating tools pass through unchanged', async () => {
  const fx = fixture()
  try {
    const listener = harness([
      { match: '/[.](rs)$/', command: 'node -e "process.exit(0)"', shell: 'none' },
    ], fx.root)
    const next = async () => ({ kind: 'accept' })
    const failed = await listener(
      { name: 'edit', arguments: { file_path: fx.file } },
      { isError: true, content: [{ type: 'text', text: 'boom' }] },
      next,
    )
    assert.equal(failed.content, undefined)
    const read = await listener(
      { name: 'read', arguments: { file_path: fx.file } },
      { isError: false, content: [{ type: 'text', text: 'content' }] },
      next,
    )
    assert.equal(read.content, undefined)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('requireFile skips a rule when its project marker is absent', async () => {
  const fx = fixture()
  try {
    const listener = harness([
      {
        match: '/[.](rs)$/',
        command: 'node -e "process.exit(0)"',
        shell: 'none',
        requireFile: 'tsconfig.json',
      },
    ], fx.root)
    const decision = await listener(
      { name: 'edit', arguments: { file_path: fx.file } },
      { isError: false, content: [{ type: 'text', text: 'edited' }] },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.content, undefined)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a successful crate check enters the per-crate cooldown', async () => {
  const fx = fixture()
  try {
    const second = join(fx.crate, 'src', 'other.rs')
    writeFileSync(second, 'pub fn b() {}\n')
    const listener = harness([
      {
        match: '/[.](rs)$/',
        command: 'node -e "process.exit(0)"',
        shell: 'none',
        timeoutMs: 20000,
      },
    ], fx.root, { crateCooldownMs: 60000 })
    const next = async () => ({ kind: 'accept' })
    const first = await listener(
      { name: 'edit', arguments: { file_path: fx.file } },
      { isError: false, content: [{ type: 'text', text: 'edited' }] },
      next,
    )
    assert.equal(first.content.length, 2)
    const secondResult = await listener(
      { name: 'edit', arguments: { file_path: second } },
      { isError: false, content: [{ type: 'text', text: 'edited' }] },
      next,
    )
    assert.equal(secondResult.content, undefined)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})
