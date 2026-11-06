// Scope-limited regression for Delivery.worktree, kept next to the package it pins.
//
// The case it checks can only be exercised with real Git inside <path-to-dsh-v2>/runs: packages/delivery git()
// refuses every other root (GIT_SCOPE), and a working copy must not write into the reference tree's runs/. So the
// contract is stated against the source, the same technique verification/p3-closure.mjs uses to pin the single writer
// of the start effect. The behavioural suite is p3-team (p3b), which is exactly the one that cannot run in a copy.
// See docs/decisions/M2a-shared-reducer.md §7-10.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8');

test('the worktree is created from the base the row recorded, never from a movable HEAD', () => {
  const add = source.match(/git\(this\.repository, 'worktree', 'add', '--detach', directory, (\w+)\);/);
  assert(add, 'the worktree add call must name its base explicitly');
  assert.equal(add[1], 'base', 'the checkout must be the resolved base, not HEAD');
  assert(!/'--detach', directory, 'HEAD'/.test(source), 'no worktree may be created from a re-read HEAD');
});

test('the created worktree is checked against that base', () => {
  // git() became asynchronous and returns readback evidence when the readback stopped blocking the event loop
  // (design §3.7): the assertion is the same comparison against the recorded base, stated on the evidence value.
  assert.match(source, /const head = await git\(directory, 'rev-parse', 'HEAD'\);/);
  assert.match(source, /if \(head\.value !== base\) fail\('WORKTREE_MISMATCH'\);/);
});
