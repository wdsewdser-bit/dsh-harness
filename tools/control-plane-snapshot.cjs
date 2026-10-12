#!/usr/bin/env node
'use strict'

/**
 * Read one Team control plane through the exact plugin path the panel uses.
 *
 * Usage:
 *   node control-plane-snapshot.cjs <rootId> [homeDir]
 *
 * Prints the room/round/dispatch counts and any error the plugin swallows.
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const rootId = process.argv[2]
const home = process.argv[3] || 'D:\\dsh-test\\home'
if (!rootId) {
  console.error('usage: node control-plane-snapshot.cjs <rootId> [homeDir]')
  process.exit(2)
}

const modulePath = path.join(home, 'profiles', 'web', 'plugins', 'team-control-plane.mjs')
const mod = await import(pathToFileURL(modulePath).href)

const control = mod.controlPlaneFor(rootId, { home })
const snapshot = control.snapshot()
console.log('file:', mod.controlPlaneFile(rootId, { home }))
console.log('exists:', mod.controlPlaneStoreExists(rootId, { home }))
console.log('rooms:', Object.keys(snapshot.rooms ?? {}).length)
console.log('rounds:', Object.keys(snapshot.rounds ?? {}).length)
console.log('dispatches:', Object.keys(snapshot.dispatches ?? {}).length)
console.log('boards:', Object.keys(snapshot.boards ?? {}).length)
console.log('roomIds:', Object.keys(snapshot.rooms ?? {}).join(', ') || '(none)')
