/**
 * Runtime hard stops for Agent Team provider failures.
 *
 * Prompt instructions explain the workflow; this module enforces the part that
 * must survive a model forgetting it. Deterministic provider failures are
 * recorded once in the Team control plane, all in-flight work is failed or
 * cancelled, and subordinate model steps are refused until tier 0 resumes the
 * Team after fixing the provider.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { controlPlaneForMember } from './team-control-plane.mjs'

export const name = 'team-runtime-guard'
export const inject = ['agentTeams', 'sessionQuery', 'sessions', 'systemPrompt']

const PERMANENT_STATUS = new Set([401, 402, 403])
const SESSION_LIST_CACHE_VERSION = 1
const SESSION_LIST_CACHE_SYMBOL = Symbol.for('dsh.team.session-list-cache.v1')
const LIVE_OBSERVATION_LAZY_SYMBOL = Symbol.for('dsh.team.live-observation-lazy.v1')
const SESSION_LIST_CACHE_REFRESH_MS = 60_000
const SESSION_LIST_CACHE_DEBOUNCE_MS = 1_000
const SESSION_LIST_CACHE_HARD_STALE_MS = 24 * 60 * 60 * 1_000
const TAIL_SOURCE_CACHE_LIMIT = 2
const ZSTD_MAGIC = 0xFD2FB528
const SESSION_LIST_MUTATING_EVENTS = new Set([
  'session/created',
  'session/disposed',
  'session/end-seed',
  'session/title',
  'user/message',
])

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function readSessionListCache(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.version !== SESSION_LIST_CACHE_VERSION || !Array.isArray(value.items)) return undefined
    if (!Number.isFinite(value.updatedAt)) return undefined
    return { items: value.items, updatedAt: value.updatedAt }
  } catch {
    return undefined
  }
}

function writeSessionListCache(path, items, updatedAt) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = path + '.tmp-' + process.pid + '-' + String(Date.now())
    writeFileSync(temporary, JSON.stringify({
      version: SESSION_LIST_CACHE_VERSION,
      updatedAt,
      items,
    }), 'utf8')
    renameSync(temporary, path)
  } catch {
    // The cache is an optimization. A read failure must fall back to the
    // original session-query path rather than affecting Session availability.
  }
}

/**
 * Add a bounded read-through cache in front of the session-query listing
 * boundary. The core persistence patch is the long-term owner; this bridge
 * keeps the current process responsive when that module was loaded before the
 * patch was installed.
 */
export function createSessionListCache(service, options = {}) {
  if (service === undefined || service === null || typeof service.listSessions !== 'function') {
    return { listSessions: undefined, invalidate: () => {}, dispose: () => {}, status: () => ({ installed: false }) }
  }
  const existing = service[SESSION_LIST_CACHE_SYMBOL]
  const state = existing ?? {
    original: service.listSessions,
    value: undefined,
    updatedAt: 0,
    stale: true,
    inflight: undefined,
    timer: undefined,
    active: true,
    wrapper: undefined,
  }
  if (existing === undefined) {
    Object.defineProperty(service, SESSION_LIST_CACHE_SYMBOL, {
      value: state,
      configurable: true,
    })
  }

  const cachePath = typeof options.cachePath === 'string' ? options.cachePath : ''
  const refreshAfterMs = positiveNumber(options.refreshAfterMs, SESSION_LIST_CACHE_REFRESH_MS)
  const debounceMs = positiveNumber(options.debounceMs, SESSION_LIST_CACHE_DEBOUNCE_MS)
  const hardStaleMs = positiveNumber(options.hardStaleMs, SESSION_LIST_CACHE_HARD_STALE_MS)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const logger = options.logger
  const loaded = state.value === undefined ? readSessionListCache(cachePath) : undefined
  if (loaded !== undefined) {
    state.value = loaded.items
    state.updatedAt = loaded.updatedAt
    state.stale = true
  }

  const refresh = () => {
    if (!state.active) return Promise.resolve(state.value)
    if (state.inflight !== undefined) return state.inflight
    const operation = Promise.resolve()
      .then(() => state.original.call(service))
      .then((items) => {
        if (!state.active) return items
        state.value = items
        state.updatedAt = now()
        state.stale = false
        writeSessionListCache(cachePath, items, state.updatedAt)
        return items
      })
      .catch((error) => {
        state.stale = true
        logger?.warn?.('[team-runtime-guard] session list refresh failed: ' + String(error?.message ?? error))
        throw error
      })
      .finally(() => {
        if (state.inflight === operation) state.inflight = undefined
      })
    state.inflight = operation
    return operation
  }

  const scheduleRefresh = () => {
    if (!state.active || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void refresh().catch(() => {})
    }, debounceMs)
    state.timer.unref?.()
  }

  const invalidate = () => {
    state.stale = true
  }

  const listSessions = async (signal) => {
    signal?.throwIfAborted?.()
    const age = now() - state.updatedAt
    if (state.value !== undefined && age <= hardStaleMs) {
      if (state.stale || age >= refreshAfterMs) scheduleRefresh()
      return state.value
    }
    try {
      return await refresh()
    } catch (error) {
      if (state.value !== undefined) {
        logger?.warn?.('[team-runtime-guard] using stale session list after refresh failure')
        return state.value
      }
      throw error
    } finally {
      signal?.throwIfAborted?.()
    }
  }

  state.active = true
  state.wrapper = listSessions
  service.listSessions = listSessions
  return {
    listSessions,
    invalidate,
    dispose() {
      state.active = false
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      if (service.listSessions === state.wrapper) service.listSessions = state.original
      if (state.wrapper === listSessions) state.wrapper = undefined
    },
    status() {
      return {
        installed: service.listSessions === state.wrapper,
        cached: state.value !== undefined,
        stale: state.stale,
        updatedAt: state.updatedAt,
        inflight: state.inflight !== undefined,
      }
    },
  }
}

function sliceIndex(value, length, fallback) {
  const numeric = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(numeric)) return numeric === Infinity ? length : 0
  const integer = Math.trunc(numeric)
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length)
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt Zstandard session log: invalid frame magic at byte ' + String(offset))
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('corrupt Zstandard session log: reserved frame-header bit at byte ' + String(offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('corrupt Zstandard session log: reserved block type at byte ' + String(offset - 3))
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function fileRevision(path) {
  const stats = statSync(path, { bigint: true })
  return [
    String(stats.dev),
    String(stats.ino),
    String(stats.size),
    String(stats.mtimeNs),
    String(stats.ctimeNs),
  ].join(':')
}

const tailSourceCache = new Map()

function readTailSource(path, revision) {
  const key = path + '\u0000' + revision
  const cached = tailSourceCache.get(key)
  if (cached !== undefined) {
    tailSourceCache.delete(key)
    tailSourceCache.set(key, cached)
    return cached
  }
  if (fileRevision(path) !== revision) throw new Error('session log changed before tail read')
  const buffer = readFileSync(path)
  if (fileRevision(path) !== revision) throw new Error('session log changed during tail read')
  const scanned = scanZstdFrames(buffer)
  if (scanned.tornStart !== undefined) throw new Error('session log has a torn final frame')
  if (scanned.frames.length === 0) throw new Error('session log has no Zstandard frames')
  const source = {
    buffer,
    frames: scanned.frames,
    decoded: new Map(),
    frameMeta: new Map(),
    lowestDecoded: scanned.frames.length,
    lastSeq: undefined,
    length: undefined,
  }
  tailSourceCache.set(key, source)
  while (tailSourceCache.size > TAIL_SOURCE_CACHE_LIMIT) {
    tailSourceCache.delete(tailSourceCache.keys().next().value)
  }
  return source
}

function decodeTailFrame(source, index) {
  if (index < 0 || index >= source.frames.length) return undefined
  const cached = source.decoded.get(index)
  if (cached !== undefined) {
    source.decoded.delete(index)
    source.decoded.set(index, cached)
    return cached
  }
  const frame = source.frames[index]
  const plaintext = zstdDecompressSync(source.buffer.subarray(frame.start, frame.end))
  const events = []
  for (const line of plaintext.toString('utf8').split(/\r?\n/)) {
    if (line.length === 0) continue
    const event = JSON.parse(line)
    if (event?.type !== 'session') events.push(event)
  }
  source.decoded.set(index, events)
  source.frameMeta.set(index, events.length === 0 ? undefined : {
    firstSeq: Number(events[0].seq),
    lastSeq: Number(events[events.length - 1].seq),
  })
  source.lowestDecoded = Math.min(source.lowestDecoded, index)
  return events
}

function ensureTailLength(source) {
  if (source.length !== undefined) return source.length
  for (let index = source.frames.length - 1; index >= 0; index -= 1) {
    const events = decodeTailFrame(source, index)
    if (events !== undefined && events.length > 0) {
      source.lastSeq = Number(events[events.length - 1].seq)
      source.length = Number.isSafeInteger(source.lastSeq) && source.lastSeq >= 0 ? source.lastSeq + 1 : 0
      return source.length
    }
  }
  source.length = 0
  return source.length
}

function tailEventAt(source, rawIndex) {
  const length = ensureTailLength(source)
  const numeric = Number(rawIndex)
  if (!Number.isFinite(numeric)) return undefined
  const integer = Math.trunc(numeric)
  const index = integer < 0 ? length + integer : integer
  if (index < 0 || index >= length) return undefined
  for (let frameIndex = source.frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
    const meta = source.frameMeta.get(frameIndex)
    if (meta === undefined || index < meta.firstSeq || index > meta.lastSeq) continue
    const events = source.decoded.get(frameIndex)
    if (events !== undefined) return events.find((event) => Number(event.seq) === index)
  }
  for (let frameIndex = source.lowestDecoded - 1; frameIndex >= 0; frameIndex -= 1) {
    const events = decodeTailFrame(source, frameIndex)
    if (events === undefined || events.length === 0) continue
    const firstSeq = Number(events[0].seq)
    const lastSeq = Number(events[events.length - 1].seq)
    if (index < firstSeq || index > lastSeq) continue
    return events.find((event) => Number(event.seq) === index)
  }
  return undefined
}

function tailSlice(source, start, end) {
  const length = ensureTailLength(source)
  const from = sliceIndex(start, length, 0)
  const to = sliceIndex(end, length, length)
  if (from >= to) return []
  const rows = []
  for (let index = from; index < to; index += 1) {
    const event = tailEventAt(source, index)
    if (event !== undefined) rows.push(event)
  }
  return rows
}

function tailMaterialize(source) {
  const rows = []
  for (let index = 0; index < source.frames.length; index += 1) {
    const events = decodeTailFrame(source, index)
    if (events !== undefined) rows.push(...events)
  }
  return rows
}

/**
 * Present a stored Session's dense log as an Array-compatible tail view.
 *
 * The history controller only needs `.at(-1)`, numeric indexing, and
 * `.slice(start,end)` for pagination. Decoding frames from the tail avoids
 * replaying a large cold log just to render its newest page.
 */
export function createTailBackedEvents(path, revision = fileRevision(path)) {
  const source = readTailSource(path, String(revision))
  let materialized
  const materialize = () => {
    materialized ??= tailMaterialize(source)
    return materialized
  }
  const target = []
  return new Proxy(target, {
    get(array, property, receiver) {
      if (property === 'length') return ensureTailLength(source)
      if (property === 'at') return (index) => tailEventAt(source, index)
      if (property === 'slice') return (start, end) => tailSlice(source, start, end)
      if (property === Symbol.iterator) {
        return function* iterate() {
          yield* materialize()
        }
      }
      if (property !== 'constructor' && typeof property === 'string' && typeof Array.prototype[property] === 'function') {
        return (...args) => Array.prototype[property].apply(materialize(), args)
      }
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        return tailEventAt(source, Number(property))
      }
      return Reflect.get(array, property, receiver)
    },
  })
}

async function createColdTailObservation(ctx, sessionId, options) {
  if (options?.projectionMode !== 'none' || ctx?.sessions?.get?.(sessionId) !== undefined) return undefined
  const persistence = typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || persistence === null
    || typeof persistence.findLog !== 'function'
    || typeof persistence.readGenerationHeader !== 'function') return undefined
  try {
    const selected = await persistence.findLog(sessionId, options?.signal)
    if (selected === undefined || selected === null
      || typeof selected.sourcePath !== 'string'
      || selected.sourcePath !== selected.currentPath
      || !selected.sourcePath.endsWith('.jsonl.zstd')) return undefined
    const header = await persistence.readGenerationHeader(selected, sessionId, options?.signal)
    if (header === undefined || header === null || header.isSeeded === true) return undefined
    const revision = fileRevision(selected.sourcePath)
    const events = createTailBackedEvents(selected.sourcePath, revision)
    const observation = {
      source: 'prepared',
      header,
      inheritedEventCount: 0,
      events,
      cursor: events.length - 1,
      revision,
      retain: () => observation,
      [Symbol.dispose]: () => {},
    }
    return observation
  } catch {
    return undefined
  }
}

/**
 * Present a live Session's dense log as an Array-compatible lazy view.
 *
 * The history controller only needs `.at(-1)`, numeric indexing, and
 * `.slice(start,end)` for pagination. Array methods keep working through the
 * Proxy, while these hot operations avoid materializing every event in a large
 * live Session just to render the newest page.
 */
export function createLazyLiveEvents(session, cursor) {
  const length = Math.max(0, Number(cursor) + 1)
  let materialized
  const materialize = () => {
    materialized ??= session.snapshotEvents(0, length)
    return materialized
  }
  const atIndex = (value) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return undefined
    const integer = Math.trunc(numeric)
    const index = integer < 0 ? length + integer : integer
    return index >= 0 && index < length ? index : undefined
  }
  const target = []
  target.length = length
  return new Proxy(target, {
    get(array, property, receiver) {
      if (property === 'at') {
        return (index) => {
          const normalized = atIndex(index)
          return normalized === undefined ? undefined : session.eventAt(normalized)
        }
      }
      if (property === 'slice') {
        return (start, end) => {
          const from = sliceIndex(start, length, 0)
          const to = sliceIndex(end, length, length)
          return from >= to ? [] : session.snapshotEvents(from, to)
        }
      }
      if (property === Symbol.iterator) {
        return function* iterate() {
          for (let index = 0; index < length; index += 1) yield session.eventAt(index)
        }
      }
      // Array methods such as map/filter/reduce walk the proxy target's own
      // indices. The target is sparse, so route explicit full-array methods
      // through one dense snapshot while keeping pagination operations lazy.
      if (property !== 'constructor' && typeof property === 'string' && typeof Array.prototype[property] === 'function') {
        return (...args) => Array.prototype[property].apply(materialize(), args)
      }
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        const index = Number(property)
        return index < length ? session.eventAt(index) : undefined
      }
      return Reflect.get(array, property, receiver)
    },
  })
}

function wrapLiveObservation(observation, session) {
  if (observation?.source !== 'live' || session === undefined || session === null) return observation
  const events = createLazyLiveEvents(session, observation.cursor ?? session.seq - 1)
  return new Proxy(observation, {
    get(target, property) {
      if (property === 'events') return events
      if (property === 'retain' && typeof target.retain === 'function') {
        return () => wrapLiveObservation(target.retain(), session)
      }
      return Reflect.get(target, property, target)
    },
  })
}

/**
 * Install the lazy live-history bridge over the currently loaded
 * session-query package. This is needed because package patches applied after
 * DSH starts remain dormant until restart; profile HMR can still activate the
 * same read behavior without restarting the running process.
 */
export function createLiveObservationLazy(service, ctx) {
  if (service === undefined || service === null || typeof service.observeSession !== 'function') {
    return { installed: false, dispose: () => {}, status: () => ({ installed: false }) }
  }
  const existing = service[LIVE_OBSERVATION_LAZY_SYMBOL]
  const state = existing ?? {
    original: service.observeSession,
    wrapper: undefined,
    impl: undefined,
  }
  state.impl = (sessionId, observation) => wrapLiveObservation(observation, ctx?.sessions?.get?.(sessionId))
  if (existing === undefined) {
    Object.defineProperty(service, LIVE_OBSERVATION_LAZY_SYMBOL, {
      value: state,
      configurable: true,
    })
  }
  if (state.wrapper === undefined) {
    const wrapper = async function observeSessionLazy(sessionId, options) {
      const tail = await createColdTailObservation(ctx, sessionId, options)
      if (tail !== undefined) return tail
      const observation = await state.original.call(this, sessionId, options)
      return state.impl(sessionId, observation)
    }
    state.wrapper = wrapper
    service.observeSession = wrapper
  }
  return {
    installed: service.observeSession === state.wrapper,
    dispose() {
      if (service.observeSession === state.wrapper) service.observeSession = state.original
      try { delete service[LIVE_OBSERVATION_LAZY_SYMBOL] } catch {}
    },
    status() {
      return {
        installed: service.observeSession === state.wrapper,
        lazyLive: true,
      }
    },
  }
}

function installSessionListInvalidation(ctx, cache) {
  const disposers = []
  const on = (event, listener) => {
    if (typeof ctx.on !== 'function') return
    disposers.push(ctx.on(event, listener, { global: true, prepend: true }))
  }
  on('session/created', () => cache.invalidate())
  on('session/disposed', () => cache.invalidate())
  on('session/flush', () => cache.invalidate())
  on('session/event', (_session, event) => {
    if (SESSION_LIST_MUTATING_EVENTS.has(event?.type)) cache.invalidate()
  })
  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
  }
}

function textOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** Classify only failures that cannot improve by immediately retrying. */
export function classifyProviderFailure(payload = {}) {
  const failure = payload.failure ?? payload.error ?? {}
  const status = Number(failure.status ?? failure.statusCode ?? failure.httpStatus ?? payload.status)
  const provider = payload.provider === undefined || payload.provider === null ? undefined : String(payload.provider)
  const text = [
    failure.code,
    failure.type,
    failure.name,
    failure.message,
    failure.error,
    textOf(failure),
  ].filter(Boolean).join(' ')
  const auth = /invalid[_ -]?api[_ -]?key|unauthori[sz]ed|forbidden|authentication|access denied/i.test(text)
  const durableRateLimit = Number(status) === 429
    && /weekly|monthly|usage limit|limit resets|quota reset|reset at/i.test(text)
  const credits = /credit|insufficient|balance|quota exhausted|account limit|billing/i.test(text) || durableRateLimit
  const safety = /safety|request illegal|content.*(?:review|policy)|moderation|policy.*(?:review|violation)/i.test(text)
  const permanent = !safety && (PERMANENT_STATUS.has(status) || auth || credits)
  if (safety) {
    const summary = (String(failure.message ?? failure.error ?? text).trim() || 'provider safety refusal').slice(0, 800)
    return {
      permanent: false,
      safety: true,
      status: Number.isFinite(status) ? status : null,
      provider,
      category: 'provider-safety',
      summary,
    }
  }
  if (!permanent) return { permanent: false, status: Number.isFinite(status) ? status : null, provider }
  const category = auth ? 'provider-auth' : credits ? 'provider-quota' : 'provider-http-' + (Number.isFinite(status) ? status : 'failure')
  const summary = (String(failure.message ?? failure.error ?? text).trim() || 'provider request failed').slice(0, 800)
  return {
    permanent: true,
    status: Number.isFinite(status) ? status : null,
    provider,
    category,
    summary,
  }
}

function requestMetrics(payload = {}) {
  const request = payload.request ?? payload.options ?? payload
  const messages = Array.isArray(request?.messages)
    ? request.messages
    : Array.isArray(payload.messages)
      ? payload.messages
      : []
  let serialized = ''
  try { serialized = JSON.stringify(messages) } catch { serialized = textOf(messages) }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  const packRows = messages.flatMap((message) => {
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content.map((part) => textOf(part?.text ?? part?.content ?? part)).join('\n')
    return /\[team[- ]context|versioned Team context|team-context-pack/i.test(text) ? [text] : []
  })
  return {
    requestBytes: bytes,
    requestTokens: Math.ceil(bytes / 4),
    contextPack: packRows.slice(-3).join('\n---\n').slice(0, 8000),
    providerResponse: textOf(payload.failure ?? payload.error ?? payload).slice(0, 2000),
  }
}

function inactiveContext(error) {
  return /inactive context/i.test(String(error?.message ?? error))
}

function rootAgent(ctx, agent) {
  try {
    const membership = ctx.agentTeams?.tryMembership?.(agent)
    return membership?.root === agent || (membership?.role === 'lead' && membership?.root === undefined)
  } catch (error) {
    // An HMR-disposed context cannot enforce a Team guard. Fail open for this
    // stale hook instead of turning the next message into an immediate error.
    return inactiveContext(error)
  }
}

function controlFor(ctx, agent, config) {
  return controlPlaneForMember(ctx, agent, {
    directory: typeof config.controlDir === 'string' && config.controlDir.length > 0
      ? config.controlDir
      : undefined,
  })
}

async function recordFailure(ctx, config, payload, classified) {
  if (!classified.permanent && classified.safety !== true) return
  const control = controlFor(ctx, payload.agent, config)
  if (control === undefined) return
  try {
    const metrics = requestMetrics(payload)
    await control.providerFailure({
      category: classified.category,
      summary: classified.summary,
      provider: classified.provider,
      status: classified.status,
      member: payload.agent?.name ?? payload.agent?.id,
      safety: classified.safety === true,
      ...metrics,
    }, payload.agent)
    ctx.logger?.error?.('[team-runtime-guard] Team provider ' + (classified.safety === true ? 'safety fallback' : 'blocked') + ': ' + classified.summary)
  } catch (error) {
    ctx.logger?.error?.('[team-runtime-guard] failed to persist provider failure: ' + String(error?.message ?? error))
  }
}

export function apply(ctx, config = {}) {
  const disposers = []
  const sessionListCache = createSessionListCache(ctx.sessionQuery, {
    cachePath: typeof config.sessionListCachePath === 'string' && config.sessionListCachePath.length > 0
      ? config.sessionListCachePath
      : join(process.env.DSH_HOME ?? process.cwd(), 'session-list-cache.json'),
    refreshAfterMs: config.sessionListRefreshAfterMs,
    debounceMs: config.sessionListRefreshDebounceMs,
    hardStaleMs: config.sessionListHardStaleMs,
    logger: ctx.logger,
  })
  disposers.push(() => sessionListCache.dispose())
  disposers.push(installSessionListInvalidation(ctx, sessionListCache))
  const liveObservationLazy = createLiveObservationLazy(ctx.sessionQuery, ctx)
  disposers.push(() => liveObservationLazy.dispose())
  const promptGuardKey = Symbol.for('dsh.team.prompt-inactive-context-guard.v2')
  const promptSafeKey = Symbol.for('dsh.team.prompt-inactive-context-safe.v1')
  const promptPrototype = ctx.systemPrompt === undefined ? undefined : Object.getPrototypeOf(ctx.systemPrompt)
  if (promptPrototype !== undefined && promptPrototype[promptGuardKey] === undefined) {
    const originalAssemble = promptPrototype.assemble
    const safeAssemble = async function safeAssemble(context = {}) {
      const scopeLayers = this.layers.chainLayers(context.scope)
      for (const layer of [this.layers.global, ...scopeLayers]) {
        for (const [name, section] of layer.sections.entries()) {
          if (!String(name).startsWith('team:') || typeof section?.text !== 'function' || section.text[promptSafeKey] === true) continue
          const originalText = section.text
          const safeText = function safeTeamPromptSection(innerContext) {
            try {
              return originalText.call(this, innerContext)
            } catch (error) {
              if (inactiveContext(error)) return ''
              throw error
            }
          }
          Object.defineProperty(safeText, promptSafeKey, { value: true })
          section.text = safeText
        }
      }
      try {
        return await originalAssemble.call(this, context)
      } catch (error) {
        if (inactiveContext(error)) return ''
        throw error
      }
    }
    Object.defineProperty(safeAssemble, promptSafeKey, { value: true })
    Object.defineProperty(promptPrototype, promptGuardKey, { value: true, configurable: true })
    promptPrototype.assemble = safeAssemble
  }
  console.warn('[team-runtime-guard] HMR prompt-inactive-context-guard+session-list-cache+perf47-live-lazy+perf48-lazy-array-methods+perf54-cold-tail-history loaded 2026-09-28')
  const on = (event, listener) => {
    if (typeof ctx.on !== 'function') return
    disposers.push(ctx.on(event, listener, { global: true, prepend: true }))
  }

  on('agent/request-error', async (payload, next) => {
    const classified = classifyProviderFailure(payload)
    await recordFailure(ctx, config, payload, classified)
    if (classified.safety === true) {
      try {
        payload.agent?.inject?.(createUserMessage({
          content: [{ type: 'text', text: '[provider-safety-fallback] The provider refused the full request. The next Team step uses a reduced context pack; request metrics and the refused pack were recorded in the control plane. Retry only after the reduced pack is injected.' }],
          source: { kind: 'user' },
        }))
      } catch {}
      return undefined
    }
    // Only the retry plugin may recover transient failures. A deterministic
    // auth/quota failure must stop the waterfall here, otherwise downstream
    // retry policy can spend more requests against a provider we already
    // marked terminal.
    if (classified.permanent) return undefined
    return typeof next === 'function' ? next() : undefined
  })
  on('agent/error', async (payload, next) => {
    const classified = classifyProviderFailure({ ...payload, error: payload.error })
    await recordFailure(ctx, config, payload, classified)
    return typeof next === 'function' ? next() : undefined
  })
  on('agent/pre-step', async (payload, next) => {
    const prior = typeof next === 'function' ? await next() : { kind: 'enter', messages: payload.messages ?? [] }
    if (prior?.kind === 'reject' || rootAgent(ctx, payload.agent)) return prior
    const control = controlFor(ctx, payload.agent, config)
    let membership
    try {
      membership = ctx.agentTeams?.tryMembership?.(payload.agent)
    } catch (error) {
      if (inactiveContext(error)) return prior
      throw error
    }
    const privilege = membership?.name === undefined ? undefined : control?.privilegeActive?.(membership.name)
    if (privilege !== undefined && privilege !== null) return prior
    if (membership?.name !== undefined) {
      const approved = control?.privilegeList?.('approved')?.some((row) => row.member === membership.name)
      if (approved === true) return prior
    }
    const blocked = control?.providerState?.().status === 'blocked'
    if (blocked) {
      ctx.logger?.warn?.('[team-runtime-guard] refusing subordinate step while Team provider is blocked')
      return { kind: 'reject' }
    }
    return prior
  })

  // Keep one model-visible reminder available to a root Lead without waking it
  // recursively. The actual hard stop is the pre-step rejection above.
  on('agent/created', async ({ agent }) => {
    const control = controlFor(ctx, agent, config)
    if (control?.providerState?.().status !== 'blocked' || !rootAgent(ctx, agent)) return
    try {
      agent.inject?.(createUserMessage({
        content: [{ type: 'text', text: '[team provider blocked] 先修复凭证或额度，再调用 team_provider_resume；未恢复前不要重新派发任务。' }],
        source: { kind: 'user' },
      }))
    } catch {}
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
  }
}
