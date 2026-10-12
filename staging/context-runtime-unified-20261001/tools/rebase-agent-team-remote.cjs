#!/usr/bin/env node
'use strict'

/**
 * Rebase the old read-write Team task Remote additions onto the 0.1.7 package.
 * The 0.1.7 domain still implements createTask/updateTask; upstream only reduced
 * the generated Remote surface to view. The local panel keeps task management,
 * so restore the generated host/remote descriptors from the 0.1.6 package.
 */

const fs = require('node:fs')

const [currentHostPath, oldHostPath, currentRemotePath, oldRemotePath] = process.argv.slice(2)
if (!currentHostPath || !oldHostPath || !currentRemotePath || !oldRemotePath) {
  process.stderr.write('usage: rebase-agent-team-remote.cjs <currentHost> <oldHost> <currentRemote> <oldRemote>\n')
  process.exit(1)
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

let current = normalize(fs.readFileSync(currentHostPath, 'utf8'))
const old = normalize(fs.readFileSync(oldHostPath, 'utf8'))
const viewMarker = 'let _deepseek_ai_dsh_experimental_agent_team_agentTeams_view_parameter_0'
const oldViewMarker = old.indexOf(viewMarker)
if (oldViewMarker < 0) throw new Error('old host face view marker not found')

const oldHeaderEnd = old.indexOf("import { z } from 'zod'\n")
if (oldHeaderEnd < 0) throw new Error('old host face import not found')
const schemaText = old.slice(oldHeaderEnd + "import { z } from 'zod'\n".length, oldViewMarker).trim()
const currentImport = "import { z } from 'zod'\n"
if (!current.includes(currentImport)) throw new Error('current host face import not found')
if (!current.includes('agentTeams/createTask')) {
  current = current.replace(currentImport, `${currentImport}\n${schemaText}\n`)
  const viewInvocation = "    {\n      id: '@deepseek-ai/dsh-experimental-agent-team#agentTeams/view'"
  const createInvocation = "    {\n      id: '@deepseek-ai/dsh-experimental-agent-team#agentTeams/createTask'"
  const currentViewAt = current.indexOf(viewInvocation)
  const oldCreateAt = old.indexOf(createInvocation)
  const oldViewAt = old.indexOf(viewInvocation)
  if (currentViewAt < 0 || oldCreateAt < 0 || oldViewAt < 0) throw new Error('host face invocation markers not found')
  const createAndUpdate = old.slice(oldCreateAt, oldViewAt)
  current = current.slice(0, currentViewAt) + createAndUpdate + current.slice(currentViewAt)
  fs.writeFileSync(currentHostPath, current)
}

if (!fs.readFileSync(currentRemotePath, 'utf8').includes('agentTeams/createTask')) {
  fs.copyFileSync(oldRemotePath, currentRemotePath)
}

process.stdout.write('[rebase-agent-team-remote] host and remote faces updated\n')
