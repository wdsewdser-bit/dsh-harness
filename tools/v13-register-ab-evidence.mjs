#!/usr/bin/env node
/**
 * Register the deterministic v13 A/B report as a v12 evidence record.
 *
 * The report is system-level evidence, so it belongs to the `default`
 * control plane rather than to one Team session. Registration is idempotent:
 * the report's source hash is part of the evidence id.
 */

import { readFileSync } from 'node:fs'
import { createEvidenceRegistry, registerEvidence } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { controlPlaneFor } from '../home/profiles/web/plugins/team-control-plane.mjs'

const reportPath = process.argv[2] || 'D:\\dsh-test\\home\\team-control-plane\\v13-mechanism-ab.json'
const home = process.argv[3] || 'D:\\dsh-test\\home'
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const binding = report?.binding ?? {}
const recordInput = {
  ...(report?.v12Evidence ?? {}),
  id: report?.v12Evidence?.id || 'v13-mechanism-ab-' + String(binding.sourceHash ?? 'unknown').slice(0, 16),
  requirementId: report?.v12Evidence?.requirementId || 'v13-mechanism-ab',
  status: report?.v12Evidence?.status || (report?.comparison?.verdict === 'keep' ? 'passed' : 'failed'),
  evidenceRef: reportPath,
  command: report?.v12Evidence?.command || 'node tools/v13-mechanism-ab.mjs',
  sourceHash: binding.sourceHash ?? null,
  configHash: binding.configHash ?? null,
  fixtureHash: binding.fixtureHash ?? null,
  fixtureVersion: binding.fixtureVersion ?? null,
  model: binding.model ?? null,
}

const control = controlPlaneFor('default', { home })
const stored = await control.mutate('v13/mechanism-ab-evidence', {
  reportPath,
  evidenceId: recordInput.id,
}, undefined, (latest) => {
  const registry = createEvidenceRegistry(Object.values(latest.v12Evidence?.records ?? {}))
  const record = registerEvidence(registry, recordInput)
  latest.v12Evidence = registry
  return record
})

console.log(JSON.stringify({
  ok: true,
  file: control.file,
  evidenceId: stored.id,
  status: stored.status,
  fingerprint: stored.fingerprint,
  fixtureHash: stored.fixtureHash,
}, null, 2))
