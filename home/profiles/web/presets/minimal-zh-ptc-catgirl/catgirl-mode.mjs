/**
 * 猫娘预设「长会话锚定」共用的会话事实读取。
 *
 * 为什么单独一个文件：尾部锚定（catgirl-persona-anchor.mjs）和压缩后重热
 * （catgirl-reheat.mjs）都要回答同两个问题——「这个会话的预热跑完没有」和
 * 「这个会话是不是子代理」——只有一份实现才不会两边判断打架。
 *
 * 两个判定都走**持久事件**，所以 resume / 重载后结论一致，不依赖进程内状态。
 * 读取走 session.snapshotEvents()：当前 Session 已不再暴露 .events（旧字段
 * 只作为兼容兜底保留）。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 预热插件注册的 user 消息来源名，用于数预热轮次。 */
export const WARMUP_PLUGIN = 'zh-warmup-ptc-replay'

/**
 * 一个会话的持久事件（旧到新）。
 * @param session - 会话对象，可能为 undefined。
 * @returns 事件数组；读不到时返回空数组（绝不抛）。
 */
export function sessionEvents(session) {
  if (session === undefined || session === null) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/**
 * 子代理会话判定。两种 header 形状都读，避免版本差异把子代理当成主会话
 * （那会给每个子代理也发锚定，白花钱）。
 * @param session - 会话对象。
 * @returns 是否为子代理会话。
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if ((header.delegationDepth ?? 0) > 0) return true
  return (header.origin ?? header.meta?.origin) === 'subagent'
}

/** 数一个会话里已经落地的预热 user 消息条数。 */
function countWarmupMessages(events) {
  let count = 0
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.plugin === WARMUP_PLUGIN) count += 1
  }
  return count
}

/**
 * 预热完成闸门：预热没跑完之前，锚定和重热都不许插话，免得污染那几轮
 * few-shot 的字节形态。
 *
 * @param requiredRounds - 预热轮数（来自 replay.json）。<= 0 表示不等待
 *   （预设没挂预热插件时用这个值）。
 * @returns { observe, isDone } — observe 喂 session/event，isDone 查询。
 */
export function createWarmupGate(requiredRounds) {
  const required = Number.isSafeInteger(requiredRounds) && requiredRounds > 0 ? requiredRounds : 0
  /** sessionId -> { count } */
  const seen = new Map()

  /** 冷会话扫一次持久日志，之后增量维护。 */
  const entryFor = (session) => {
    const sid = session?.id
    if (sid === undefined || sid === null) return { count: 0 }
    const cached = seen.get(sid)
    if (cached !== undefined) return cached
    const entry = { count: countWarmupMessages(sessionEvents(session)) }
    seen.set(sid, entry)
    return entry
  }

  return {
    /** 增量 feed：每条 session/event 都调一次。 */
    observe(session, event) {
      if (required === 0) return
      if (event?.type !== 'user/message') return
      if (event.data?.source?.plugin !== WARMUP_PLUGIN) return
      const sid = session?.id
      if (sid === undefined || sid === null) return
      const entry = seen.get(sid) ?? { count: countWarmupMessages(sessionEvents(session)) }
      entry.count += 1
      seen.set(sid, entry)
    },
    /** 预热是否已经走完（没有预热插件时恒为 true）。 */
    isDone(session) {
      if (required === 0) return true
      return entryFor(session).count >= required
    },
  }
}

/**
 * 读一个和预设同目录的 JSON 文件（预热/重热文案）。
 * @param target - 相对预设目录的相对路径，或绝对路径。
 * @param callerUrl - 调用方插件的 import.meta.url，用来解析相对路径。
 * @returns 解析后的对象，失败返回 undefined（绝不抛）。
 */
export function readJson(target, callerUrl) {
  if (typeof target !== 'string' || target.length === 0) return undefined
  try {
    const url = isAbsolute(target) ? pathToFileURL(target) : new URL(target, callerUrl)
    return JSON.parse(readFileSync(url, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 从预热 replay.json 里取轮数，作为预热闸门的阈值。
 * @param replayFile - replay 文件路径（相对预设目录）。
 * @param callerUrl - 调用方 import.meta.url。
 * @param fallback - 读不到时的兜底轮数（默认 0 = 不等待）。
 * @returns 非负整数轮数。
 */
export function warmupRoundCount(replayFile, callerUrl, fallback = 0) {
  const document = readJson(replayFile, callerUrl)
  const rounds = document?.rounds
  if (Array.isArray(rounds) && rounds.length > 0) return rounds.length
  return Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 0
}
