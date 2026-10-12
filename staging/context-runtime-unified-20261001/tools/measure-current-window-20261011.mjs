import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowMessageBytes } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { ReactLoopInbox, inboxProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { SessionProjectionRegistry } from '../app/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const nativeSession = await import(new URL('../app/node_modules/@deepseek-ai/dsh-session/lib/index.js', import.meta.url))
const { Context } = await import(new URL('../app/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url))
const persistenceModule = await import(new URL('../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', import.meta.url))
const JsonlSessionPersistence = persistenceModule.default

const sessionId = 'session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a'
const sessionRoot = 'D:\\dsh-test\\home\\sessions'
const expectedProjectCwd = 'D:\\dsh-test\\workspaces\\window-large2-20261008'
const sessionFile = 'D:\\dsh-test\\home\\sessions\\--D-dsh-test-workspaces-window-large2-20261008--\\session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a\\session.v4.jsonl.zstd'
const decisionsDir = 'D:\\dsh-test\\home\\window-decisions'
const outputFile = 'D:\\dsh-test\\output\\window-measure-current-20261011.json'
const recentMessages = 6
const sha256 = value => createHash('sha256').update(value).digest('hex')
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const rawMessage = event => event.type === 'user/message' ? event.data : event.data?.message
const hasSender = value => typeof value === 'string' && value.length > 0

function isRuntimeState(message) {
  return message?.role === 'user' && message.source?.senderSessionId === undefined
    && message.source?.senderId === undefined && message.source?.teamId === undefined
    && (['team-v12-runtime', 'team-activity-digest', 'team-idle-watch', 'step-compaction'].includes(message.source?.plugin)
      || (message.source?.plugin === 'tool-agent-team-v2'
        && (message.source.form === 'snapshot' || message.source.kind === 'team-plugin-message')))
}

function isTeammateOriginal(message) {
  return message?.role === 'user'
    && (hasSender(message.source?.senderSessionId) || hasSender(message.source?.senderId) || hasSender(message.source?.teamId))
}

function isHumanInput(message) {
  return message?.role === 'user' && !isRuntimeState(message) && !isTeammateOriginal(message)
}

function completedTurns(events) {
  const turns = []
  let start
  for (const event of events) {
    if (event.type === 'turn/start') { start = event; continue }
    if (event.type !== 'turn/end') continue
    if (start && start.data?.turn === event.data?.turn && event.data?.reason?.kind === 'completed') {
      turns.push(events.filter(row => row.seq >= start.seq && row.seq <= event.seq))
    }
    start = undefined
  }
  return turns
}

function protectedIdsFor(events, messages) {
  const lastStart = events.filter(event => event.type === 'turn/start').at(-1)
  const currentStart = lastStart?.seq ?? 0
  const closed = lastStart !== undefined && events.some(event => event.type === 'turn/end'
    && event.seq > lastStart.seq && event.data?.turn === lastStart.data?.turn
    && event.data?.reason?.kind === 'completed')
  const canonical = new Map(events.filter(event => rawMessage(event)?.id).map(event => [rawMessage(event).id, event]))
  const open = message => {
    const event = canonical.get(message.id)
    return event === undefined || (!closed && event.seq >= currentStart)
  }
  return new Set([...messages.slice(-recentMessages).map(message => message.id),
    ...messages.filter(message => ['system', 'developer'].includes(message.role) || open(message)).map(message => message.id)])
}

function foldCandidates(events, messages, protectedIds, { allowTeammates = false, protectHumanInputs = true, selectionMode = 'single' } = {}) {
  const at = new Map(messages.map((message, index) => [message.id, index]))
  const intact = event => {
    const message = rawMessage(event)
    const index = at.get(message?.id)
    return index !== undefined && !protectedIds.has(message.id)
      && sha256(JSON.stringify(message)) === sha256(JSON.stringify(messages[index]))
  }
  const consecutive = list => list.every((event, index) => index === 0
    || at.get(rawMessage(event).id) === at.get(rawMessage(list[index - 1]).id) + 1)
  const bytes = list => windowMessageBytes(list.map(rawMessage))
  const isBridgeMessage = message => isRuntimeState(message) || (allowTeammates && isTeammateOriginal(message))
  const candidates = []

  for (const turnEvents of completedTurns(events)) {
    const group = turnEvents.filter(event => rawMessage(event)?.id
      && !['system', 'developer'].includes(rawMessage(event).role))
    if (!group.length) continue
    const turn = turnEvents[0].data.turn

    // The production collector's whole-turn shortcut also absorbs the leading user message.
    // Keep it visible in the report, but exclude human-input turns from protected R/T metrics.
    const wholeTurn = rawMessage(group[0]).role === 'user' && rawMessage(group.at(-1)).role === 'assistant'
      && group.every(intact) && consecutive(group)
    if (wholeTurn && selectionMode === 'single') {
      const humanInputs = group.filter(event => isHumanInput(rawMessage(event)))
      candidates.push({ scope: 'turn', turn, group, all: turnEvents, humanInputCount: humanInputs.length,
        humanInputBytes: bytes(humanInputs), eligibleWithHumanProtection: !protectHumanInputs || humanInputs.length === 0 })
      continue
    }

    const runs = []
    let best = [], run = [], trail = []
    const close = () => {
      if (run.length > 1) { runs.push(run); if (bytes(run) > bytes(best)) best = run }
      run = []; trail = []
    }
    for (let i = 0; i < group.length;) {
      const message = rawMessage(group[i])
      const calls = message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'tool-call').map(block => block.id) : []
      if (!calls.length) {
        if (run.length && isBridgeMessage(message) && intact(group[i])) trail.push(group[i])
        else close()
        i++
        continue
      }
      const step = [group[i]], answered = new Set()
      let j = i + 1
      while (j < group.length && rawMessage(group[j]).role === 'tool') {
        step.push(group[j])
        answered.add(rawMessage(group[j]).toolCallId)
        j++
      }
      const callsPaired = calls.every(id => answered.has(id))
      if (!callsPaired || !step.every(intact) || !consecutive(step)) close()
      else if (run.length && consecutive([run.at(-1), ...trail, ...step])) {
        run.push(...trail, ...step)
        trail = []
      } else {
        close()
        run.push(...step)
      }
      i = j
    }
    close()
    for (const chosen of selectionMode === 'multiple' ? runs : (best.length >= 2 ? [best] : [])) {
      candidates.push({ scope: 'steps', turn, group: chosen,
        all: turnEvents.filter(event => event.seq >= chosen[0].seq && event.seq <= chosen.at(-1).seq),
        humanInputCount: 0, humanInputBytes: 0, eligibleWithHumanProtection: true })
    }
  }
  return candidates
}

function summarizeSelection(messages, candidates, selectionMode) {
  const selected = selectionMode === 'single'
    ? candidates.filter(candidate => candidate.eligibleWithHumanProtection)
      .sort((a, b) => windowMessageBytes(b.group.map(rawMessage)) - windowMessageBytes(a.group.map(rawMessage))).slice(0, 1)
    : candidates.filter(candidate => candidate.eligibleWithHumanProtection)
  const ids = new Set(selected.flatMap(candidate => candidate.group.map(event => rawMessage(event).id)))
  const removed = messages.filter(message => ids.has(message.id))
  const remaining = messages.filter(message => !ids.has(message.id))
  const pairedSteps = selected.filter(candidate => candidate.scope === 'steps').map(candidate => {
    let callCount = 0, pairedCallCount = 0, unpairedCallCount = 0
    const stepMessages = candidate.group.map(rawMessage)
    for (let index = 0; index < stepMessages.length;) {
      const message = stepMessages[index]
      const calls = message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'tool-call').map(block => block.id) : []
      if (!calls.length) { index++; continue }
      callCount += calls.length
      const results = new Set()
      let next = index + 1
      while (next < stepMessages.length && stepMessages[next].role === 'tool') {
        results.add(stepMessages[next].toolCallId)
        next++
      }
      const paired = calls.filter(id => results.has(id)).length
      pairedCallCount += paired
      unpairedCallCount += calls.length - paired
      index = next
    }
    return { turn: candidate.turn, messageCount: candidate.group.length, callCount, pairedCallCount, unpairedCallCount }
  })
  return {
    candidateCount: selected.length,
    foldedMessageCount: removed.length,
    foldedMessageJsonBytes: removed.reduce((sum, message) => sum + jsonBytes(message), 0),
    modelVisibleBytesRemoved: windowMessageBytes(messages) - windowMessageBytes(remaining),
    modelVisibleBytesBefore: windowMessageBytes(messages),
    modelVisibleBytesAfterRemovalOnly: windowMessageBytes(remaining),
    unit: 'model-visible-Harness-JSON-bytes', providerWireBytes: 'unknown', providerTokens: 'unknown',
    currentMessagesBodyJsonBytes: jsonBytes(messages),
    bodyJsonBytesIfCandidatesWereRemoved: jsonBytes(remaining),
    removedMessageIdsForInternalValidationOnly: [...ids],
    scopes: selected.reduce((out, candidate) => {
      out[candidate.scope] = (out[candidate.scope] ?? 0) + 1
      return out
    }, {}),
    humanInputCountInSelectedCandidates: selected.reduce((sum, candidate) => sum + candidate.humanInputCount, 0),
    humanInputJsonBytesInSelectedCandidates: selected.reduce((sum, candidate) => sum + candidate.humanInputBytes, 0),
    foldedRuntimeStateMessageCount: removed.filter(isRuntimeState).length,
    foldedTeammateOriginalMessageCount: removed.filter(isTeammateOriginal).length,
    foldedHumanOrUnclassifiedUserMessageCount: removed.filter(isHumanInput).length,
    pairedToolSteps: pairedSteps,
    allToolCallsPaired: pairedSteps.every(step => step.unpairedCallCount === 0)
  }
}

function publicSummary(summary) {
  const { removedMessageIdsForInternalValidationOnly, ...safe } = summary
  return safe
}

async function matchingDecisionFacts() {
  const facts = { filesScanned: 0, matchedRecords: 0, matchedFiles: 0, matchedKindsAndOutcomes: {}, matchedKeySets: {} }
  const matchedFiles = new Set()
  async function scan(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) { await scan(file); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      facts.filesScanned++
      const text = await readFile(file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes(sessionId)) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        facts.matchedRecords++
        matchedFiles.add(file)
        const kind = [row?.kind, row?.mechanism, row?.action].find(value => typeof value === 'string') ?? 'untyped'
        const outcome = typeof row?.outcome === 'string' ? row.outcome : 'unspecified'
        const category = `${kind}|${outcome}`
        facts.matchedKindsAndOutcomes[category] = (facts.matchedKindsAndOutcomes[category] ?? 0) + 1
        const keySet = Object.keys(row ?? {}).sort().join(',') || 'empty'
        facts.matchedKeySets[keySet] = (facts.matchedKeySets[keySet] ?? 0) + 1
      }
    }
  }
  await scan(decisionsDir)
  facts.matchedFiles = matchedFiles.size
  return facts
}

let handle
try {
  const fileStat = await stat(sessionFile)
  const fileHash = sha256(await readFile(sessionFile))
  const ctx = new Context()
  const backend = new JsonlSessionPersistence(ctx, { root: sessionRoot, compression: 'zstd' })
  const id = nativeSession.SessionId(sessionId)
  const before = await backend.stat(id)
  if (!before) throw new Error('NATIVE_SESSION_STAT_NOT_FOUND')
  handle = await backend.open(id, 'read')
  if (handle.access !== 'read') throw new Error('NATIVE_SESSION_NOT_READ_ONLY')
  const stored = await handle.read()
  const after = await backend.stat(id)
  if (!after || String(before.revision) !== String(after.revision)) throw new Error('NATIVE_SESSION_CHANGED_DURING_READ')
  if (handle.id !== sessionId || handle.header.cwd?.toLowerCase() !== expectedProjectCwd.toLowerCase()) {
    throw new Error('NATIVE_SESSION_IDENTITY_MISMATCH')
  }

  const restored = nativeSession.Session.fromRestore(handle.id, stored.events, handle.header,
    handle.inheritedEventCount, stored.eventState)
  const events = restored.snapshotEvents()
  const messages = restored.deriveMessages()
  const protectedIds = protectedIdsFor(events, messages)
  const registry = new SessionProjectionRegistry(ctx)
  registry.register(inboxProjectionDefinition)
  const inbox = new ReactLoopInbox(registry, restored, { emit() {} })
  const pending = [...inbox.nextStep, ...inbox.nextTurn]
  for (const message of pending) if (messages.some(row => row.id === message.id)) protectedIds.add(message.id)
  const rCandidates = foldCandidates(events, messages, protectedIds, { allowTeammates: false, protectHumanInputs: true })
  const rMultipleCandidates = foldCandidates(events, messages, protectedIds, { allowTeammates: false, protectHumanInputs: true, selectionMode: 'multiple' })
  const tCandidates = foldCandidates(events, messages, protectedIds, { allowTeammates: true, protectHumanInputs: true, selectionMode: 'multiple' })
  const exactCollectorR = summarizeSelection(messages, rCandidates, 'single')
  const exactCollectorRAll = summarizeSelection(messages, rMultipleCandidates, 'multi')
  const diagnosticT = summarizeSelection(messages, tCandidates, 'single')
  const diagnosticTAll = summarizeSelection(messages, tCandidates, 'multi')
  const exactCollectorWholeTurns = rCandidates.filter(candidate => candidate.scope === 'turn')
  const wholeTurnHumanInputCount = exactCollectorWholeTurns.reduce((sum, candidate) => sum + candidate.humanInputCount, 0)
  const wholeTurnHumanInputBytes = exactCollectorWholeTurns.reduce((sum, candidate) => sum + candidate.humanInputBytes, 0)
  const sourceKinds = {}
  const userSourceMetadata = {}
  for (const message of messages) {
    const key = message.source?.kind ?? message.source?.plugin ?? 'unspecified'
    sourceKinds[key] = (sourceKinds[key] ?? 0) + 1
    if (message.role === 'user') {
      const senderFields = ['senderSessionId', 'senderId', 'teamId'].filter(field => message.source?.[field] !== undefined)
      const userKey = `${key}|${senderFields.join('+') || 'no-sender-fields'}`
      userSourceMetadata[userKey] = (userSourceMetadata[userKey] ?? 0) + 1
    }
  }
  const eventTypes = {}
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
  const projection = events.filter(event => event.type === 'user/message').map(event => event.data?.source ?? {})
  const checkpointMessages = projection.filter(source => source.nativeWindowCheckpoint !== undefined).length
  const windowCommitMessages = projection.filter(source => source.windowCommit !== undefined).length
  const decisionFacts = await matchingDecisionFacts()

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'completed',
    task: 'read-only measurement of the current derived conversation for the named test root',
    source: {
      sessionId,
      sourceFile: sessionFile,
      sourceFileBytes: fileStat.size,
      sourceFileSha256: fileHash,
      storageRoot: sessionRoot,
      projectCwd: handle.header.cwd,
      sessionHeaderVersion: handle.header.version,
      sessionApiVersion: '0.1.7-rc.2',
      persistencePackageVersion: '0.1.7-rc.2',
      sessionFormatVersion: nativeSession.SESSION_FORMAT_VERSION,
      persistenceAccess: handle.access,
      persistenceEventState: stored.eventState,
      logicalEventCount: events.length,
      eventTypes,
      sourceKinds,
      userSourceMetadata,
      matchingDecisionFacts: decisionFacts
    },
    derivedConversation: {
      messageCount: messages.length,
      messagesBodyJsonBytes: jsonBytes(messages),
      rawAdapterOptionsJsonBytes: jsonBytes(messages),
      modelVisibleHarnessJsonBytes: windowMessageBytes(messages),
      persistedPendingInputCount: pending.length,
      persistedPendingProtection: 'native ReactLoopInbox projection; live arrivals after this disk snapshot are unknown',
      perMessageJsonBytes: messages.reduce((sum, message) => sum + jsonBytes(message), 0),
      recentTailProtectionMessages: recentMessages,
      protectedMessageCount: protectedIds.size,
      runtimeStateMessageCount: messages.filter(isRuntimeState).length,
      teammateOriginalMessageCount: messages.filter(isTeammateOriginal).length,
      unprovenTeamMessageKindCount: messages.filter(message => message.role === 'user'
        && message.source?.kind === 'team-message' && !isTeammateOriginal(message)).length,
      humanOrUnclassifiedUserMessageCount: messages.filter(isHumanInput).length,
      explicitlyUserSourcedMessageCount: messages.filter(message => message.role === 'user' && message.source?.kind === 'user').length,
      preservationWitness: messages.filter(message => isHumanInput(message) || isTeammateOriginal(message)
        || message.role === 'assistant' && !(message.content ?? []).some(block => block.type === 'tool-call'))
        .map(message => ({ id: message.id, role: message.role, sha256: sha256(JSON.stringify(message)),
          contentSha256: sha256(JSON.stringify(message.content)),
          category: isTeammateOriginal(message) ? 'teammate-original' : message.role === 'assistant' ? 'assistant-text' : 'protected-user' })),
      priorSummaryCompressionState: {
        summaryCompressedAtLeastOnce: (eventTypes['compaction/summary'] ?? 0) > 0,
        nativeWindowCheckpointMessages: checkpointMessages,
        windowCommitMessages,
        compactionSummaryEvents: eventTypes['compaction/summary'] ?? 0,
        compactionEndEvents: eventTypes['compaction/end'] ?? 0,
        projectionReplacementEvents: events.filter(event => event.surfaceOp?.op === 'replace').length
      }
    },
    rules: {
      R: {
        evaluated: true,
        deployed: false,
        measurementOnly: true,
        definition: 'existing R: runtime state messages may bridge paired assistant-tool steps; teammate originals and human inputs end a step run',
        singleSegment: publicSummary(exactCollectorR),
        allDisjointCandidates: publicSummary(exactCollectorRAll),
        exactCollectorWholeTurnShortcut: {
          candidateCount: exactCollectorWholeTurns.length,
          humanInputMessageCountWouldBeAbsorbed: wholeTurnHumanInputCount,
          humanInputMessageJsonBytesWouldBeAbsorbed: wholeTurnHumanInputBytes,
          note: 'Existing collector code has a complete-turn shortcut that can include older user messages; these candidates are excluded from the protected R metrics above when they contain a human or unclassified user message.'
        }
      },
      T_diagnostic_only: {
        enabled: false,
        definition: 'diagnostic only: teammate originals may bridge paired assistant-tool steps; human or unclassified user inputs remain hard boundaries',
        singleSegment: publicSummary(diagnosticT),
        allDisjointCandidates: publicSummary(diagnosticTAll),
        teammateOriginalMessageCount: messages.filter(isTeammateOriginal).length,
        humanInputsRemainProtected: true
      }
    },
    measurementNotes: [
      'Raw adapter-options bytes include host source metadata. The separate model-visible Harness JSON budget excludes it but conservatively includes assistant replay signatures. Provider HTTP bytes and tokens are unknown. Generated checkpoint/replacement overhead is not subtracted.',
      'R multi enumerates all complete step runs in every completed turn, without the legacy whole-turn shortcut. R single preserves the old candidate branch and separately reports its human-input absorption risk.',
      'Step candidates require each assistant tool-call id to have a matching tool result in the same candidate and require contiguous order on the current derived surface.',
      'R counts runtime-state messages as bridgeable and treats teammate originals and all non-runtime, non-teammate user messages as boundaries.',
      'Human-source classification uses source.kind=user; unknown non-runtime user messages are treated as protected boundaries as well.',
      'T permits only user messages with senderSessionId, senderId, or teamId provenance to bridge a run; team-message source.kind without those fields stays a boundary.',
      'T is a counterfactual measurement only; it is not enabled, deployed, or written to the session.',
      'Persisted pending inbox is reconstructed through the native ReactLoopInbox projection. Inputs accepted after this snapshot remain unknown; a real commit must recheck its live inbox and CAS bindings.'
    ],
    validationCommand: "node --check 'D:\\dsh-test\\staging\\context-runtime-unified-20261001\\tools\\measure-current-window-20261011.mjs'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node 'D:\\dsh-test\\staging\\context-runtime-unified-20261001\\tools\\measure-current-window-20261011.mjs'"
  }
  if (messages.length !== 384) report.derivedConversation.expected384MessageCheck = 'mismatch'
  else report.derivedConversation.expected384MessageCheck = 'matched'
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.stdout.write(JSON.stringify({ status: report.status, outputFile, messageCount: messages.length,
    messagesBodyJsonBytes: report.derivedConversation.messagesBodyJsonBytes,
    modelVisibleHarnessJsonBytes: report.derivedConversation.modelVisibleHarnessJsonBytes,
    rMultiModelVisibleBytesRemoved: report.rules.R.allDisjointCandidates.modelVisibleBytesRemoved,
    rMultiCandidates: report.rules.R.allDisjointCandidates.candidateCount,
    persistedPendingInputCount: report.derivedConversation.persistedPendingInputCount,
    rSingle: { messages: report.rules.R.singleSegment.foldedMessageCount, bytes: report.rules.R.singleSegment.foldedMessageJsonBytes },
    rMulti: { messages: report.rules.R.allDisjointCandidates.foldedMessageCount, bytes: report.rules.R.allDisjointCandidates.foldedMessageJsonBytes },
    tSingle: { messages: report.rules.T_diagnostic_only.singleSegment.foldedMessageCount, bytes: report.rules.T_diagnostic_only.singleSegment.foldedMessageJsonBytes },
    tMulti: { messages: report.rules.T_diagnostic_only.allDisjointCandidates.foldedMessageCount, bytes: report.rules.T_diagnostic_only.allDisjointCandidates.foldedMessageJsonBytes },
    wholeTurnHumanInputCountWouldBeAbsorbed: wholeTurnHumanInputCount,
    expected384MessageCheck: report.derivedConversation.expected384MessageCheck }, null, 2) + '\n')
} catch (error) {
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    reason: error?.code ?? error?.message ?? String(error),
    sessionId,
    sourceFile: sessionFile,
    note: 'No conversation text or secrets are included.'
  }
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  process.stdout.write(JSON.stringify({ status: report.status, outputFile, reason: report.reason }) + '\n')
  process.exitCode = 2
} finally {
  await handle?.close()
}
