import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createLedgerWriter } from './request-usage-ledger.mjs'

export const name = 'ptc-sdk-retention'
export const inject = ['llm', 'requestMessageProjection']
export const SDK_TITLE = '## Writing code for run_code'
export const DEFAULT_PURPOSE_POLICY = Object.freeze({ conversation: 'ptc-only', compaction: 'retain' })
// Pinned to the audited renderer's fixed instructions, including its valid bash example.
export const SDK_PREFIX_SHA256 = 'ba37d53fb5868ea64d767a62b42907532903399dd9ac7f407a03042d34def0aa'
export const AUDITED_SDK_CHAIN = Object.freeze([
  'fef0c8ce9e5c30a33500dd0cad154917f63e644264df81e8439df3bf221ec198',
  '86458ac75f81cec673152732fea2faf7199de831d302c5eda4e60c07dbe65889',
  '970578d6b15cd8b32ddcf2ca06e75c6a548aa1421dc76d7023ce718dfe60b007',
  '295ff1107853f260502fee9dc224feaeebc0ddfa213a6e6bb8116225a0c31c0c',
  '36fb549199503b202530c0acc2f51f1a84e4dad808f1ccf6a05762d406ef215e',
])
const SDK_TAIL = 'declare const tools: {\n  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;\n}\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null

export function verifySdkCompatibility(manifest, versions) {
  const result = { id: 'CTX-SDK-01-known-chain', version: 1, verified: false,
    explanation: 'only the five audited fixture hashes in nondecreasing order; future contracts require a new review', reason: null }
  if (!manifest) return { ...result, reason: 'compatibility-certificate-missing' }
  if (manifest.version !== 1 || manifest.id !== result.id || manifest.sdkPrefixSha256 !== SDK_PREFIX_SHA256
    || manifest.latestSha256 !== AUDITED_SDK_CHAIN.at(-1)
    || JSON.stringify(manifest.orderedSdkHashes) !== JSON.stringify(AUDITED_SDK_CHAIN)) return { ...result, reason: 'compatibility-certificate-invalid' }
  const indices = versions.map(value => AUDITED_SDK_CHAIN.indexOf(value))
  if (indices.some(index => index < 0)) return { ...result, reason: 'compatibility-unknown-sdk-version' }
  if (versions.at(-1) !== manifest.latestSha256) return { ...result, reason: 'compatibility-latest-version-mismatch' }
  if (indices.some((index, position) => position > 0 && index < indices[position - 1])) return { ...result, reason: 'compatibility-version-order-mismatch' }
  return { ...result, verified: true }
}

/** Boundaries are accepted only for the exact audited, generated TypeScript section. */
export function findSdkSection(text) {
  if (typeof text !== 'string') return { status: 'absent' }
  if (!text.includes(SDK_TITLE)) return { status: 'absent' }
  const titles = [...text.matchAll(/^## Writing code for run_code$/gm)]
  if (titles.length !== 1 || text.split(SDK_TITLE).length !== 2) return { status: 'malformed', reason: 'ambiguous-sdk-title' }
  const start = titles[0].index
  const open = text.indexOf('\n```ts\n', start)
  if (open < 0) return { status: 'malformed', reason: 'unknown-sdk-fence' }
  const fenceStart = open + 1
  if (hash(text.slice(start, fenceStart)) !== SDK_PREFIX_SHA256) return { status: 'malformed', reason: 'unknown-sdk-instructions' }
  const codeStart = open + '\n```ts\n'.length
  const remainder = text.slice(codeStart)
  const boundary = /^```[^\n]*$/m.exec(remainder)
  if (!boundary || boundary[0] !== '```') return { status: 'malformed', reason: 'unknown-sdk-closing-fence' }
  const close = codeStart + boundary.index
  const code = text.slice(codeStart, close)
  if (!code.startsWith('type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\ninterface ToolArgsMap {')
    || !code.includes('\n\ninterface ToolOutputMap {')
    || !code.includes('\n\ntype ToolName = keyof ToolOutputMap\n\n')
    || !code.endsWith(SDK_TAIL)) return { status: 'malformed', reason: 'unknown-sdk-declaration-shape' }
  const end = close + 3
  const sdk = text.slice(start, end)
  return { status: 'valid', start, end, bytes: Buffer.byteLength(sdk), sha256: hash(sdk) }
}

function messageMeasurement(messages) {
  const serialized = JSON.stringify(messages)
  const systems = messages.filter(message => message?.role === 'system' && message?.source?.kind === 'system-prompt')
    .flatMap(message => message.content ?? []).filter(block => block?.type === 'text').map(block => block.text)
  return {
    bytes: Buffer.byteLength(serialized), sha256: hash(serialized),
    systemTextBytes: systems.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    systemTextSha256: hash(JSON.stringify(systems)),
  }
}

function ptcOnly(options) {
  if (!Array.isArray(options?.tools) || options.tools.length !== 1) return false
  const tool = options.tools[0]
  const parameters = tool?.parameters
  return tool?.name === 'run_code' && parameters?.properties?.code?.type === 'string'
    && parameters?.properties?.description?.type === 'string'
    && parameters?.required?.includes('code') && parameters.required.includes('description')
}

/** A candidate projection; applying it requires a supported runtime request boundary. */
export function projectSdkRetention(options, config = {}) {
  const mode = config.mode === 'apply' ? 'apply' : 'shadow'
  const policy = config.policy === 'latest' ? 'latest' : 'exact-only'
  const audit = {
    version: 1, mode, policy,
    status: 'skipped', skipReasons: [], before: null, after: null, candidateAfter: null,
    sdkCopies: null, retainedCopies: null, removedCopies: 0, candidateRemovedCopies: 0,
    changedCopies: null, candidateSavedSdkBytes: 0, sdkGrossRemovedBytes: 0, replacementBytes: 0, sdkVersions: [],
    sdkScanComplete: false, historicalContractInterpretationChanged: false,
    compatibilityCertificate: null,
    measurementSource: 'request-message-JSON-and-system-text; not wire bytes or tokens',
  }
  const unchanged = reason => {
    audit.skipReasons.push(reason)
    audit.after = audit.before
    audit.candidateAfter = audit.before
    audit.retainedCopies = audit.sdkCopies
    return { options, candidate: options, audit }
  }
  try {
    if (!Array.isArray(options?.messages)) return unchanged('unknown-request-shape')
    audit.before = messageMeasurement(options.messages)
    const purpose = options.purpose ?? 'conversation'
    const purposePolicy = (config.purposePolicy ?? DEFAULT_PURPOSE_POLICY)[purpose]
    audit.purpose = purpose
    audit.purposePolicy = purposePolicy ?? 'retain'
    if (purpose === 'conversation') {
      if (purposePolicy !== 'ptc-only') return unchanged('purpose-policy-retain')
      if (!ptcOnly(options)) return unchanged('not-ptc-run-code-only')
    } else if (purpose !== 'compaction' || purposePolicy !== 'certified-latest') return unchanged('auxiliary-request')
    if (options.system) return unchanged('one-shot-system-slot')
    const found = []
    let lastSystemIndex = -1
    for (let messageIndex = 0; messageIndex < options.messages.length; messageIndex++) {
      const message = options.messages[messageIndex]
      if (message?.role !== 'system' || message?.source?.kind !== 'system-prompt') continue
      lastSystemIndex = messageIndex
      if (!Array.isArray(message.content)) return unchanged('unknown-system-content-shape')
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex]
        if (block?.type !== 'text') continue
        const section = findSdkSection(block.text)
        if (section.status === 'malformed') return unchanged(section.reason)
        if (section.status === 'valid') found.push({ ...section, messageIndex, blockIndex })
      }
    }
    audit.sdkCopies = found.length
    audit.sdkScanComplete = true
    audit.sdkVersions = found.map(({ messageIndex, blockIndex, bytes, sha256 }) => ({ messageIndex, blockIndex, bytes, sha256 }))
    if (found.length === 0) return unchanged('no-sdk')
    const latest = found.at(-1)
    if (purpose === 'compaction') {
      audit.compatibilityCertificate = verifySdkCompatibility(config.compatibilityManifest, found.map(item => item.sha256))
      if (!audit.compatibilityCertificate.verified) return unchanged(audit.compatibilityCertificate.reason)
    }
    if (latest.messageIndex !== lastSystemIndex) return unchanged('latest-system-has-no-sdk')
    if (found.some((item, index) => index > 0 && item.messageIndex === found[index - 1].messageIndex)) return unchanged('multiple-sdk-sections-in-one-message')
    const latestText = options.messages[latest.messageIndex].content[latest.blockIndex].text.slice(latest.start, latest.end)
    const identical = found.slice(0, -1).filter(item => {
      const text = options.messages[item.messageIndex].content[item.blockIndex].text.slice(item.start, item.end)
      return item.sha256 === latest.sha256 && text === latestText
    })
    audit.changedCopies = found.length - 1 - identical.length
    let allowChanged = false
    if (policy === 'latest' && audit.changedCopies > 0) {
      audit.compatibilityCertificate = verifySdkCompatibility(config.compatibilityManifest, found.map(item => item.sha256))
      allowChanged = audit.compatibilityCertificate.verified
      if (!allowChanged) audit.skipReasons.push(audit.compatibilityCertificate.reason)
    }
    const removals = policy === 'latest' && allowChanged ? found.slice(0, -1) : identical
    if (audit.changedCopies > 0 && policy !== 'latest') audit.skipReasons.push('changed-sdk-history-retained')
    if (removals.length === 0) return unchanged(found.length === 1 ? 'single-sdk' : 'no-identical-old-sdk')
    const messages = options.messages.slice()
    for (const section of removals) {
      const message = messages[section.messageIndex]
      const content = message.content.slice()
      const block = content[section.blockIndex]
      const replacement = policy === 'latest'
        ? `<!-- previous tools:sdk sha256=${section.sha256} bytes=${section.bytes}; latest sha256=${latest.sha256} retained -->` : ''
      audit.replacementBytes += Buffer.byteLength(replacement)
      content[section.blockIndex] = Object.freeze({ ...block, text: block.text.slice(0, section.start) + replacement + block.text.slice(section.end) })
      messages[section.messageIndex] = Object.freeze({ ...message, content: Object.freeze(content) })
    }
    const candidate = Object.freeze({ ...options, messages: Object.freeze(messages) })
    audit.candidateRemovedCopies = removals.length
    audit.sdkGrossRemovedBytes = removals.reduce((sum, section) => sum + section.bytes, 0)
    audit.candidateSavedSdkBytes = audit.sdkGrossRemovedBytes - audit.replacementBytes
    audit.historicalContractInterpretationChanged = policy === 'latest' && allowChanged && audit.changedCopies > 0
    audit.candidateAfter = messageMeasurement(messages)
    audit.status = 'candidate'
    if (mode === 'apply') {
      audit.status = 'applied-pure-projection'
      audit.after = audit.candidateAfter
      audit.removedCopies = removals.length
    } else audit.after = audit.before
    audit.retainedCopies = found.length - audit.removedCopies
    return { options: mode === 'apply' ? candidate : options, candidate, audit }
  } catch {
    return unchanged('projection-shape-or-measurement-failed')
  }
}

/** The compatibility bridge owns replacement; llm/stream itself stays observer-only. */
export function apply(ctx, config = {}) {
  const instanceId = randomUUID()
  const writer = createLedgerWriter({ directory: config.directory ?? 'D:\\dsh-test\\home\\ptc-sdk-retention-audit', instanceId, logger: ctx.logger, maxPending: config.maxPending })
  let disposed = false
  let compatibilityManifest = config.compatibilityManifest ?? null
  const certificateReady = config.compatibilityManifestPath
    ? readFile(config.compatibilityManifestPath, 'utf8').then(text => { compatibilityManifest = JSON.parse(text) }).catch(() => { compatibilityManifest = null })
    : Promise.resolve()
  let bridge
  try { bridge = ctx.get?.('requestMessageProjection') ?? ctx.requestMessageProjection } catch {}
  const canProject = typeof bridge?.register === 'function'
  const moduleHashReady = readFile(new URL(import.meta.url)).then(bytes => hash(bytes)).catch(() => null)
  const enqueue = (event, extra = {}) => moduleHashReady.then(moduleHash => writer.enqueue({
    version: 1, plugin: name, event, pid: process.pid, instanceId, moduleHash, at: new Date().toISOString(),
    requestedMode: config.mode === 'apply' ? 'apply' : 'shadow', mode: config.mode === 'apply' && canProject ? 'apply' : 'shadow',
    integration: canProject ? 'request-message-projection-bridge' : 'llm/stream-observer-only; request-projection-hook-unavailable', ...extra,
  }, event !== 'projection-candidate'))
  void enqueue('loaded')
  const project = options => {
    let projectedMessages = options?.messages
    if (!disposed) {
      try {
        const result = projectSdkRetention(options, { mode: config.mode === 'apply' && canProject ? 'apply' : 'shadow', policy: config.policy, purposePolicy: config.purposePolicy, compatibilityManifest })
        if (config.mode === 'apply' && !canProject) result.audit.skipReasons.push('runtime-request-projection-hook-unavailable')
        projectedMessages = result.options.messages
        void enqueue('projection-candidate', {
          auditId: randomUUID(), sessionId: safeId(options?.sessionId), provider: safeId(options?.provider), model: safeId(options?.model),
          ...result.audit,
        })
      } catch { /* An audit or shape failure cannot veto the request. */ }
    }
    return { messages: projectedMessages }
  }
  const preview = options => ({ messages: projectSdkRetention(options, {
    mode: config.mode === 'apply' ? 'apply' : 'shadow', policy: config.policy, purposePolicy: config.purposePolicy, compatibilityManifest,
  }).options.messages })
  const unregister = canProject ? bridge.register(name + ':' + instanceId, project, { order: 10, preview })
    : ctx.on?.('llm/stream', (options, next) => { project(options); return next() }, { global: true })
  const dispose = async () => {
    if (!disposed) {
      disposed = true
      try { unregister?.() } catch {}
      await enqueue('disposed')
    }
    await moduleHashReady
    await writer.flush()
  }
  dispose.ready = Promise.all([moduleHashReady, certificateReady]).then(() => writer.flush())
  dispose.flush = async () => { await moduleHashReady; await writer.flush() }
  dispose.stats = () => ({ ...writer.stats(), disposed, file: writer.file, runtimeFile: writer.runtimeFile })
  return dispose
}
