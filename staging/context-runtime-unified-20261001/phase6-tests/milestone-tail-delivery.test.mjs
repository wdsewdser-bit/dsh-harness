#!/usr/bin/env node
/** The milestone belongs at the current request tail and never in the cacheable system prefix. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (condition || detail === undefined ? '' : '  ' + detail))
}

const dir = mkdtempSync(join(tmpdir(), 'team-milestone-tail-'))
const milestonePath = join(dir, 'team-milestones.json')
const scopesFile = join(dir, 'write-scopes.json')
const reportDir = join(dir, 'reports')
writeFileSync(scopesFile, JSON.stringify({ byName: {}, bySession: {} }), 'utf8')
writeFileSync(milestonePath, JSON.stringify({
  version: 2,
  teams: {
    'team-1': {
      members: {
        lead: { owner: 'lead', stage: 'first stage', doneWhen: 'first proof', setAt: 1, done: false },
      },
      bands: {},
      compactions: {},
    },
  },
}), 'utf8')

const sectionDefinitions = []
const preStepHandlers = []
let injected = 0
let deriveCalls = 0
let visible = []
const agent = {
  name: 'lead',
  membership: { id: 'team-1', name: 'lead', role: 'lead' },
  session: { deriveMessages: () => { deriveCalls += 1; return visible } },
  inject: () => { injected += 1 },
  ctx: {
    systemPrompt: {
      section: (definition) => { sectionDefinitions.push(definition); return () => {} },
      getSectionOrder: () => 0,
    },
    tools: { register: () => () => {} },
    on: (event, handler) => {
      if (event === 'agent/pre-step') preStepHandlers.push(handler)
      return () => {}
    },
  },
}
const membership = agent.membership
const ctx = {
  agents: { list: () => [agent] },
  agentTeams: {
    tryMembership: () => membership,
    membership: () => membership,
    listMembers: () => [],
  },
  set: (key, value) => { ctx[key] = value },
  logger: { warn: (message) => { throw new Error(message) } },
  on: () => {},
  effect: () => {},
}

policyMod.apply(ctx, {})
toolsMod.apply(ctx, { milestonePath, scopesFile, reportDir })

check('one Team policy section and one pre-step hook are installed',
  sectionDefinitions.length === 1 && preStepHandlers.length === 1,
  JSON.stringify({ sections: sectionDefinitions.length, preStep: preStepHandlers.length }))

const firstPrompt = sectionDefinitions[0].text()
check('the system prompt section is milestone-independent',
  !firstPrompt.includes('first stage') && !firstPrompt.includes('first proof'),
  firstPrompt)

writeFileSync(milestonePath, JSON.stringify({
  version: 2,
  teams: {
    'team-1': {
      members: {
        lead: { owner: 'lead', stage: 'second stage', doneWhen: 'second proof', setAt: 2, done: false },
      },
      bands: {},
      compactions: {},
    },
  },
}), 'utf8')

const secondPrompt = sectionDefinitions[0].text()
check('changing the milestone does not mutate the system prefix', firstPrompt === secondPrompt, secondPrompt)

const hook = async (claimed) => preStepHandlers[0](
  { agent, messages: claimed },
  async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'runtime context' }] }] }),
)

const first = await hook([{ role: 'user', content: [{ type: 'text', text: 'do work' }] }])
const firstText = JSON.stringify(first.messages.at(-1)?.content ?? '')
check('the milestone is appended to the current decision tail',
  firstText.includes('[team milestone #2]') && firstText.includes('second stage'),
  firstText)
check('the milestone does not use the next-step inject queue', injected === 0)

visible = first.messages.slice(-1)
check('test fixture exposes the prior milestone on the visible surface',
  JSON.stringify(visible).includes('[team milestone #2]'),
  JSON.stringify(visible))
const second = await hook([])
check('the hook reads the live visible surface before deciding to append', deriveCalls >= 2, String(deriveCalls))
check('the durable visible surface prevents a duplicate on the next step',
  !JSON.stringify(second.messages).includes('[team milestone #2]'),
  JSON.stringify(second.messages))

visible = []
const afterCompaction = await hook([])
check('losing the marker to compaction restores it on the next request',
  JSON.stringify(afterCompaction.messages).includes('[team milestone #2]'),
  JSON.stringify(afterCompaction.messages))

console.log('checks=all failed=' + failed)
process.exitCode = failed === 0 ? 0 : 1
