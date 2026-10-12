#!/usr/bin/env node
'use strict'

/**
 * Generate a pnpm-compatible package patch between a pristine extracted npm
 * package and its locally modified copy.
 *
 * Usage:
 *   node generate-package-patch.cjs <pristineRoot> <modifiedRoot> <output> <relativeFile...>
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const [pristineRootArg, modifiedRootArg, outputArg, ...relativeFiles] = process.argv.slice(2)
if (!pristineRootArg || !modifiedRootArg || !outputArg || relativeFiles.length === 0) {
  process.stderr.write('usage: generate-package-patch.cjs <pristineRoot> <modifiedRoot> <output> <relativeFile...>\n')
  process.exit(1)
}

const pristineRoot = path.resolve(pristineRootArg)
const modifiedRoot = path.resolve(modifiedRootArg)
const chunks = []

for (const relativeFile of relativeFiles) {
  const pristineFile = path.join(pristineRoot, relativeFile)
  const modifiedFile = path.join(modifiedRoot, relativeFile)
  if (!fs.existsSync(pristineFile) || !fs.existsSync(modifiedFile)) {
    throw new Error(`missing patch input for ${relativeFile}`)
  }
  const result = spawnSync('git', [
    'diff', '--no-index', '--unified=3', '--',
    pristineFile, modifiedFile,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `git diff failed for ${relativeFile}`)
  }
  const lines = result.stdout.replace(/\r\n/g, '\n').split('\n')
  const diffIndex = lines.findIndex(line => line.startsWith('diff --git '))
  const minusIndex = lines.findIndex((line, index) => index > diffIndex && line.startsWith('--- '))
  const plusIndex = lines.findIndex((line, index) => index > minusIndex && line.startsWith('+++ '))
  if (diffIndex < 0 || minusIndex < 0 || plusIndex < 0) {
    throw new Error(`diff headers missing for ${relativeFile}`)
  }
  const slash = relativeFile.replaceAll('\\', '/')
  lines[diffIndex] = `diff --git a/${slash} b/${slash}`
  lines[minusIndex] = `--- a/${slash}`
  lines[plusIndex] = `+++ b/${slash}`
  chunks.push(lines.join('\n').replace(/\n+$/, ''))
}

fs.writeFileSync(outputArg, chunks.join('\n') + '\n')
process.stdout.write(`[generate-package-patch] wrote ${outputArg} (${relativeFiles.length} files)\n`)
