/**
 * Small synchronous durable JSON primitive for v14 state.
 *
 * The lock is a process-shared create-exclusive marker. A token written to
 * the marker is read back before entering the critical section so a caller
 * never proceeds on an unverified lock. Updates always reload while holding
 * the lock; an in-memory snapshot is never used for a write.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const STALE_LOCK_MS = 30_000

function pauseSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Atomics.wait is unavailable in a few embedded runtimes; the short spin
    // still keeps the lock bounded there.
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function readExisting(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return clone(fallback)
    // A malformed/truncated file is a durable-data error. Never turn it into
    // an empty document because that would silently discard user state.
    throw new Error('durable JSON is corrupt: ' + file + ': ' + String(error?.message ?? error))
  }
}

function acquireLock(file, timeoutMs) {
  const lock = file + '.lock'
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || DEFAULT_LOCK_TIMEOUT_MS))
  const token = process.pid + ':' + randomUUID()
  while (true) {
    let fd
    try {
      fd = openSync(lock, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }), 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      let verified
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try { verified = JSON.parse(readFileSync(lock, 'utf8')); break } catch (error) {
          if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) {
            throw new Error('durable lock verification failed: ' + String(error?.message ?? error))
          }
          pauseSync(10)
        }
      }
      if (verified?.token !== token || Number(verified?.pid) !== process.pid) {
        throw new Error('durable lock verification failed for ' + file)
      }
      return { lock, token }
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
      }
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
      try {
        const age = Date.now() - statSync(lock).mtimeMs
        if (age > 1000) {
          const owner = JSON.parse(readFileSync(lock, 'utf8'))
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            let alive = true
            try { process.kill(owner.pid, 0) } catch (probe) {
              if (probe?.code === 'ESRCH') alive = false
            }
            if (!alive && age > STALE_LOCK_MS) unlinkSync(lock)
          }
        }
      } catch {
        // Windows can briefly deny stat/read/unlink while another process
        // creates the lock. Unknown ownership must fail closed on timeout.
      }
      if (Date.now() >= deadline) throw new Error('durable lock timeout for ' + file)
      pauseSync(10)
    }
  }
}

function assertLockOwner(lock, token) {
  let owner
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { owner = JSON.parse(readFileSync(lock, 'utf8')); break } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) {
        throw new Error('durable lock ownership cannot be verified for ' + lock + ': ' + String(error?.message ?? error))
      }
      pauseSync(10)
    }
  }
  if (owner?.token !== token || Number(owner?.pid) !== process.pid) {
    throw new Error('durable lock ownership changed for ' + lock)
  }
}

function releaseLock(lock, token) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertLockOwner(lock, token)
    try { unlinkSync(lock); return } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error?.code) || attempt === 9) throw error
      pauseSync(10)
    }
  }
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid + '-' + randomUUID()
  let fd
  try {
    fd = openSync(temp, 'wx')
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, file)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temp) } catch {}
  }
}

export function readDurableJson(file, { fallback } = {}) {
  return readExisting(file, fallback)
}

export function updateDurableJsonSync(file, updater, { fallback, lockTimeoutMs } = {}) {
  if (typeof updater !== 'function') throw new TypeError('durable updater must be a function')
  const { lock, token } = acquireLock(file, lockTimeoutMs)
  try {
    const document = readExisting(file, fallback)
    const previousRevision = document !== null && typeof document === 'object' && !Array.isArray(document)
      ? (Number.isFinite(Number(document.revision)) ? Number(document.revision) : 0)
      : 0
    const result = updater(document)
    const updated = document !== null && typeof document === 'object' && !Array.isArray(document)
      ? document
      : (result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { value: result })
    updated.revision = previousRevision + 1
    assertLockOwner(lock, token)
    atomicWrite(file, updated)
    return result === undefined ? updated : result
  } finally {
    releaseLock(lock, token)
  }
}

export async function updateDurableJson(file, updater, options = {}) {
  return updateDurableJsonSync(file, updater, options)
}

export function durableFileExists(file) {
  return existsSync(file)
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
