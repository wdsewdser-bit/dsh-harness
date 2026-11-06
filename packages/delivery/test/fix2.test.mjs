import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDeliveryPort, createGitGuardRunner } from '../index.mjs';

test('fix2 worktree target rejected before spawn and registration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-target-'));
  try {
    const repository = path.join(root, 'repo'); fs.mkdirSync(repository);
    const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    git('commit', '--allow-empty', '-m', 'base');
    const before = git('worktree', 'list', '--porcelain');
    let spawned = 0;
    const port = createDeliveryPort({ repository, gitRoots: [repository], spawn: () => { spawned++; throw Error('must not spawn'); } });
    const target = path.join(root, 'missing', 'outside');
    await assert.rejects(port.worktreeAdd(target, 'HEAD'), { code: 'GIT_SCOPE' });
    assert.throws(() => port.worktreePath('task:a'), { code: 'GIT_SCOPE' });
    assert.equal(spawned, 0);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readdirSync(root).length, 1, 'no generated sibling worktree');
    assert.equal(git('worktree', 'list', '--porcelain'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fix2 synchronous guard requires positive timeout', () => {
  for (const timeoutMs of [0, -1]) assert.throws(() => createGitGuardRunner({ timeoutMs }), { code: 'INVALID_CONFIG' });
});
