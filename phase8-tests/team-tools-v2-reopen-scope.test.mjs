#!/usr/bin/env node
/** The reopen recovery helper must be module-scoped, not nested inside assertTaskPhaseCanAdvance. */
import { readFileSync } from 'node:fs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

for (const file of [
  'D:\\dsh-test\\home\\profiles\\web\\plugins\\team-tools-v2-r9.mjs',
  'D:\\dsh-test\\home\\profiles\\web\\plugins\\team-tools-v2-r8.mjs',
  'D:\\dsh-test\\home\\profiles\\headless\\plugins\\team-tools-v2.mjs',
]) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const recover = lines.findIndex((line) => line === '  const recoverTaskPhaseForReopen = async (taskId, actor) => {')
  const assert = lines.findIndex((line) => line === '  const assertTaskPhaseCanAdvance = (taskId, phase) => {')
  check(file + ': recover helper is module-scoped', recover >= 0 && assert >= 0 && recover < assert,
    JSON.stringify({ recover: recover + 1, assert: assert + 1 }))
  check(file + ': both helpers have module indentation',
    recover >= 0 && assert >= 0 && !lines[recover].startsWith('    ') && !lines[assert].startsWith('    '))
  const between = recover < 0 || assert < 0 ? '' : lines.slice(recover, assert).join('\n')
  check(file + ': recover helper closes before assert starts', /^  \}/m.test(between))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
