import test from 'node:test'
import assert from 'node:assert/strict'
import {
  armedRoots,
  clearBackgroundWakes,
  consumeBackgroundWake,
  disarmRoot,
  focusRoot,
  isArmed,
  markBackgroundWake,
} from '../home/profiles/web/plugins/team-armed-roots.mjs'

test('shared armed-root set keeps one foreground root and replaces it on a real root turn', () => {
  const set = armedRoots()
  set.clear()
  clearBackgroundWakes()

  assert.equal(focusRoot(set, 'team-old'), true)
  assert.equal(isArmed(set, 'team-old'), true)
  assert.equal(focusRoot(set, 'team-new'), true)
  assert.equal(set.size, 1)
  assert.equal(isArmed(set, 'team-old'), false)
  assert.equal(isArmed(set, 'team-new'), true)
  assert.equal(disarmRoot(set, 'team-new'), true)
  assert.equal(set.size, 0)
  set.clear()
})

test('observer-generated wakes do not steal foreground focus from the new root', () => {
  const set = armedRoots()
  set.clear()
  clearBackgroundWakes()

  focusRoot(set, 'team-old')
  focusRoot(set, 'team-new')
  markBackgroundWake('team-old')
  assert.equal(consumeBackgroundWake('team-old'), true)
  assert.equal(isArmed(set, 'team-old'), false)
  assert.equal(isArmed(set, 'team-new'), true)

  set.clear()
  clearBackgroundWakes()
})
