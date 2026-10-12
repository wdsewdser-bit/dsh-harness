import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectHealth } from '../home/profiles/web/plugins/team-health.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-health-'))
const pluginDir = join(root, 'plugins')
const scopesFile = join(root, 'write-scopes.json')
const required = ['critical.mjs', 'optional.mjs']
const criticalPath = join(pluginDir, required[0])
const optionalPath = join(pluginDir, required[1])
try {
  mkdirSync(pluginDir, { recursive: true })
  const base = {
    pluginDir,
    scopesFile,
    requiredFiles: required,
    criticalFiles: ['critical.mjs'],
    plugins: { optional: 'degraded' },
    windowTokens: 1000,
    reservedOutputTokens: 100,
    safetyMarginTokens: 50,
  }
  writeFileSync(scopesFile, JSON.stringify({ defaultDeny: true, byName: {}, bySession: {} }))
  const missing = inspectHealth(base)
  console.log((missing.status === 'disabled' ? 'PASS ' : 'FAIL ') + 'missing critical plugin disables profile')
  writeFileSync(criticalPath, 'ok')
  const partial = inspectHealth(base)
  console.log((partial.status === 'degraded' && partial.files['critical.mjs'].exists ? 'PASS ' : 'FAIL ') + 'optional plugin degrades without disabling profile')
  writeFileSync(optionalPath, 'ok')
  const healthy = inspectHealth({ ...base, plugins: { optional: 'enabled' } })
  console.log((healthy.status === 'healthy' ? 'PASS ' : 'FAIL ') + 'valid critical config reports healthy')
  writeFileSync(scopesFile, JSON.stringify({ defaultDeny: false }))
  const weakScope = inspectHealth({ ...base, plugins: { optional: 'enabled' } })
  console.log((weakScope.status === 'degraded' && weakScope.reasons.some((x) => /defaultDeny/.test(x)) ? 'PASS ' : 'FAIL ') + 'non fail-closed scope reports degraded')
  writeFileSync(scopesFile, '{broken')
  const badScope = inspectHealth({ ...base, plugins: { optional: 'enabled' } })
  console.log((badScope.status === 'disabled' && badScope.reasons.some((x) => /invalid/.test(x)) ? 'PASS ' : 'FAIL ') + 'invalid scope disables profile')
} finally {
  rmSync(root, { recursive: true, force: true })
}
