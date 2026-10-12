#!/usr/bin/env node
'use strict'

/**
 * Migrate a legacy $DSH_HOME/.agent-presets/<id> directory into a 0.1.7
 * declarative @deepseek-ai/dsh-agent-preset row in the active profile patch.
 *
 * This is deliberately mechanical:
 *   - copy preset-owned runtime assets into profiles/<profile>/presets/<id>;
 *   - rewrite relative plugin names to be profile-root relative;
 *   - preserve the legacy composition text and comments;
 *   - optionally add the Windows persistent-shell split used by shipped presets.
 *
 * Usage:
 *   node migrate-alpha7-agent-preset.cjs <sourceDir> <id> <profileDir> <patchFile> <order> [--windows-shell]
 */

const fs = require('node:fs')
const path = require('node:path')

function fail(message) {
  process.stderr.write(`[migrate-alpha7-agent-preset] ${message}\n`)
  process.exit(1)
}

function readMetadata(sourceDir) {
  const file = path.join(sourceDir, 'preset.yml')
  let name = path.basename(sourceDir)
  let description = ''
  try {
    const text = fs.readFileSync(file, 'utf8')
    const nameMatch = /^name:\s*(.+?)\s*$/m.exec(text)
    const descriptionMatch = /^description:\s*(.+?)\s*$/m.exec(text)
    if (nameMatch) name = nameMatch[1].replace(/^['"]|['"]$/g, '')
    if (descriptionMatch) description = descriptionMatch[1].replace(/^['"]|['"]$/g, '')
  } catch {
    // Metadata is optional. The id remains a valid fallback display name.
  }
  return { name, description }
}

function addWindowsShellSplit(source) {
  let next = source
  const bashNames = [
    ['- id: terminal-bash', "'@deepseek-ai/dsh-terminal-bash'"],
    ['- id: persistent-bash', "'@deepseek-ai/dsh-tool-bash-persistent'"],
  ]
  for (const [id, name] of bashNames) {
    const old = `${id}\n      name: ${name}\n      config:`
    const replacement = `${id}\n      name: ${name}\n      disabled: !!js process.platform === 'win32'\n      config:`
    if (!next.includes(old)) fail(`cannot apply Windows shell split: missing ${id}`)
    next = next.replace(old, replacement)
  }

  const anchor = '\n# Share the host filesystem seam across the editor and the Standard read/search'
  if (!next.includes(anchor)) fail('cannot apply Windows shell split: persistent-shell boundary not found')
  const pwsh = `
    - id: terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform !== 'win32'
      config:
        shellDialect: pwsh
        timeoutMs: 300000

    - id: persistent-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh-persistent'
      disabled: !!js process.platform !== 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a PowerShell shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * State is persistent across command calls and discussions with the user.
          * Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
          * Use pwsh for search, inspection, builds, tests, processes, and shell-only work.
          * For creating or precisely modifying text files, prefer str_replace_editor. Avoid heredocs, redirection, Set-Content rewrites, or one-off rewrite scripts unless the editor cannot express the change.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.`
  next = next.replace(anchor, `${pwsh}${anchor}`)
  next = next.replace(/shellTools:\s*\[bash\]/g, 'shellTools: [bash, pwsh]')
  return next
}

function copyRuntimeAssets(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name === 'preset.yml' || entry.name === 'agent.cordis.yml') continue
    if (entry.name.includes('.bak')) continue
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name))
  }
}

function replaceMigrationBlock(patchText, markerStart, markerEnd, block) {
  const start = patchText.indexOf(markerStart)
  if (start < 0) return patchText.trimEnd() + '\n\n' + block + '\n'
  const end = patchText.indexOf(markerEnd, start)
  if (end < 0) fail('preset migration start marker exists without end marker')
  return patchText.slice(0, start) + block + patchText.slice(end + markerEnd.length)
}

const [sourceDirArg, id, profileDirArg, patchFileArg, orderArg, flag] = process.argv.slice(2)
if (!sourceDirArg || !id || !profileDirArg || !patchFileArg || !orderArg) {
  fail('usage: <sourceDir> <id> <profileDir> <patchFile> <order> [--windows-shell]')
}

const sourceDir = path.resolve(sourceDirArg)
const profileDir = path.resolve(profileDirArg)
const patchFile = path.resolve(patchFileArg)
const order = Number(orderArg)
if (!Number.isInteger(order) || order < 0) fail('order must be a non-negative integer')
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('id must be lowercase kebab-case')
if (!fs.existsSync(path.join(sourceDir, 'agent.cordis.yml'))) fail(`missing ${path.join(sourceDir, 'agent.cordis.yml')}`)

const metadata = readMetadata(sourceDir)
const destinationDir = path.join(profileDir, 'presets', id)
copyRuntimeAssets(sourceDir, destinationDir)

let composition = fs.readFileSync(path.join(sourceDir, 'agent.cordis.yml'), 'utf8').replace(/\r\n/g, '\n').trimEnd()
if (flag === '--windows-shell') composition = addWindowsShellSplit(composition)
composition = composition.replace(/(\n\s*name:\s*)\.\/([^\s\n]+)/g, `$1./presets/${id}/$2`)

const markerStart = `# BEGIN alpha7-migrated-preset ${id}`
const markerEnd = `# END alpha7-migrated-preset ${id}`
const indentedComposition = composition
  .split('\n')
  .map(line => line.length === 0 ? '' : `          ${line}`)
  .join('\n')
const block = `${markerStart}
- insert:
    - id: preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${JSON.stringify(id)}
        name: ${JSON.stringify(metadata.name)}
        description: ${JSON.stringify(metadata.description)}
        order: ${order}
        plugins:
${indentedComposition}
${markerEnd}`

const original = fs.readFileSync(patchFile, 'utf8')
const updated = replaceMigrationBlock(original, markerStart, markerEnd, block)
if (updated !== original) {
  if (!fs.existsSync(`${patchFile}.bak-before-preset-${id}`)) {
    fs.copyFileSync(patchFile, `${patchFile}.bak-before-preset-${id}`)
  }
  fs.writeFileSync(patchFile, updated, 'utf8')
}
process.stdout.write(JSON.stringify({
  id,
  name: metadata.name,
  sourceDir,
  destinationDir,
  patchFile,
  changed: updated !== original,
}) + '\n')
