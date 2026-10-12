import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire('D:/dsh-test/app/node_modules/@deepseek-ai/dsh/package.json')
const yaml = require('yaml')
const base = 'D:/dsh-test'
const expected = Object.freeze({
  enabled: true,
  routeMode: 'session',
  provider: '',
  model: '',
  reasoningEffort: '',
  remoteAllowed: false,
  localProviders: ['opencodego'],
  thresholdBytes: 32768,
  maxReceiptTokens: 1200,
  maxQuotes: 16,
  timeoutMs: 45000,
  maxInputBytes: 131072,
  maxInputLines: 3000,
})

function parse(text) {
  return yaml.parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
}

function rowsFor(document, id) {
  return document.flatMap(row => [
    ...(row.insert ?? []).filter(item => item?.id === id).map(item => ({ kind: 'insert', config: item.config ?? {} })),
    ...(row.id === id ? [{ kind: 'override', config: row.config ?? {} }] : []),
  ])
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function compareConfig(config, label) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = Object.hasOwn(config, key) ? config[key] : expected[key]
    assert(JSON.stringify(actual) === JSON.stringify(value), `${label}:${key} expected ${JSON.stringify(value)} got ${JSON.stringify(actual)}`)
  }
}

for (const profile of ['web', 'headless', 'teamtest']) {
  const path = `${base}/home/profiles/${profile}/cordis.patch.yml`
  const document = parse(await readFile(path, 'utf8'))
  const reducer = rowsFor(document, 'evidence-reducer')
  const probes = JSON.stringify(document).match(/clm-(?:runtime-probe|hmr)[A-Za-z0-9_-]*/g) ?? []
  assert(probes.length === 0, `${profile}:temporary probe rows remain: ${probes.join(',')}`)
  if (profile === 'web') {
    assert(reducer.filter(row => row.kind === 'insert').length === 1, 'web:evidence-reducer insert count')
    assert(reducer.filter(row => row.kind === 'override').length === 1, 'web:evidence-reducer override count')
    compareConfig(reducer.find(row => row.kind === 'override').config, 'web:override')
    const ui = rowsFor(document, 'evidence-reducer-ui')
    assert(ui.filter(row => row.kind === 'insert').length === 1, 'web:evidence-reducer-ui insert count')
  } else if (profile === 'headless') {
    assert(reducer.filter(row => row.kind === 'insert').length === 1, 'headless:evidence-reducer insert count')
    assert(reducer.filter(row => row.kind === 'override').length === 0, 'headless:evidence-reducer override count')
    compareConfig(reducer.find(row => row.kind === 'insert').config, 'headless:insert')
  } else {
    assert(reducer.length === 0, 'teamtest:evidence-reducer patch row count')
  }
}

const settings = JSON.parse(await readFile(`${base}/home/evidence-reducer.json`, 'utf8'))
for (const [key, value] of Object.entries(expected)) assert(JSON.stringify(settings[key]) === JSON.stringify(value), `settings-file:${key}`)
console.log(JSON.stringify({ ok: true, profiles: 3, reducerConfig: expected, settingsRevision: settings.revision }))
