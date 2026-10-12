import { createHash } from 'node:crypto'

export const qualityArchive = 'EARLIER OBSERVATION: all ten requirements may be done.\n'
  + 'Supporting archived context.\n'.repeat(96)
  + 'MIDPOINT CORRECTION: only six of ten requirements are verified; four remain.\n'
  + 'Additional original detail.\n'.repeat(32)
  + 'TAIL CONSTRAINT: do not report overall completion; pending user input must remain queued.'
export const qualityArchiveCode = 'return ' + JSON.stringify('EARLIER OBSERVATION: all ten requirements may be done.\n')
  + ' + ' + JSON.stringify('Supporting archived context.\n') + '.repeat(96)'
  + ' + ' + JSON.stringify('MIDPOINT CORRECTION: only six of ten requirements are verified; four remain.\n')
  + ' + ' + JSON.stringify('Additional original detail.\n') + '.repeat(32)'
  + ' + ' + JSON.stringify('TAIL CONSTRAINT: do not report overall completion; pending user input must remain queued.') + ';'
export function matchesQualityArchive(text) {
  return text === qualityArchive || text === qualityArchive + '\nFile sandbox enforcement is partial on this host.'
}
export const qualityAnswerInstruction = 'After the SDK program succeeds, inspect the returned original artifact, resolve any conflicting earlier observation using the later correction, and answer with only a JSON object containing remaining (integer), completionAllowed (boolean), and pendingInputPolicy ("preserve" or "discard"). Derive every value from the returned original, not from this instruction. This is not completion of the platform implementation.'
export function verifyQualityAnswer(text, target) {
  try {
    const original = target.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (!matchesQualityArchive(original)) return false
    const answer = JSON.parse(text)
    return Object.keys(answer).length === 3 && answer.remaining === 4 && answer.completionAllowed === false
      && answer.pendingInputPolicy === 'preserve'
  } catch { return false }
}
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
export function historyQualityCode(seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) fail('LAB_HISTORY_SEQUENCE_REQUIRED')
  return `const located = await tools.history_recall({action:"locate",seq:${seq}});
if (located.ok !== true || located.descriptor.pairingComplete !== true) throw new Error("HISTORY_LOCATE_FAILED");
const d = located.descriptor;
if (d.bytes > 65536 || d.pages > 16 || d.sourceRef.seq !== ${seq}) throw new Error("HISTORY_QUALITY_BUDGET");
const pages = [];
const hashes = [];
let last;
for (let i = 0; i < d.pages; i++) {
  const offset = i * d.pageBytes;
  const page = await tools.history_recall({action:"read",locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:d.sourceRef.sourceHash,offset});
  if (page.ok !== true || page.offset !== offset || page.bytes < 1) throw new Error("HISTORY_PAGE_FAILED");
  pages.push(Buffer.from(page.dataBase64,"base64"));
  hashes.push(page.pageHash);
  last = page;
}
if (last.complete !== true || last.nextOffset !== null || last.receipt.status !== "full-fetched") throw new Error("HISTORY_INCOMPLETE");
const bytes = Buffer.concat(pages);
const {createHash} = await import("node:crypto");
const sha = value => createHash("sha256").update(value).digest("hex");
if (bytes.length !== d.bytes || sha(bytes) !== d.sourceRef.artifactHash || pages.some((page,i)=>sha(page)!==hashes[i])) throw new Error("HISTORY_ARTIFACT_HASH");
const artifact = JSON.parse(bytes.toString("utf8"));
if (artifact.target.seq !== ${seq} || sha(JSON.stringify(artifact.target)) !== d.sourceRef.sourceHash) throw new Error("HISTORY_TARGET_HASH");
const assembled = await tools.history_recall({action:"assemble",locator:d.locator,expectedRevision:d.sourceRef.sourceRevision,expectedSourceHash:d.sourceRef.sourceHash});
if (assembled.ok !== true || assembled.durable !== true || assembled.kind !== "history-raw-artifact-v1"
  || JSON.stringify(assembled.descriptor) !== JSON.stringify(d) || JSON.stringify(assembled.pageHashes) !== JSON.stringify(hashes)
  || JSON.stringify(assembled.artifact) !== JSON.stringify(artifact) || assembled.receipt.status !== "full-fetched"
  || assembled.deliveryCandidate.status !== "returned-awaiting-dispatch") throw new Error("HISTORY_ASSEMBLY_FAILED");
return JSON.stringify(assembled);`
}

export function createHistoryQualityGuard(sessionId, seq) {
  const code = historyQualityCode(seq), locatedCalls = new WeakSet(), descriptors = new Map()
  function mine(exec) { return exec?.agent?.id === sessionId && exec.agent.session?.id === sessionId }
  return Object.freeze({
    code,
    allow(exec) {
      if (!mine(exec)) return false
      const args = exec.arguments ?? {}, name = exec.name ?? exec.tool?.name
      if (name === 'run_code') return args.code?.trim() === code && Object.keys(args).every(key => ['code','description'].includes(key))
      if (name !== 'history_recall') return false
      if (args.action === 'locate' && Object.keys(args).length === 2 && args.seq === seq) {
        locatedCalls.add(exec); return true
      }
      const descriptor = descriptors.get(args.locator)
      if (!descriptor || args.expectedRevision !== descriptor.sourceRef.sourceRevision
        || args.expectedSourceHash !== descriptor.sourceRef.sourceHash) return false
      if (args.action === 'assemble') return Object.keys(args).length === 4
      return args.action === 'read' && Object.keys(args).length === 5
        && args.expectedRevision === descriptor.sourceRef.sourceRevision
        && args.expectedSourceHash === descriptor.sourceRef.sourceHash
        && Number.isSafeInteger(args.offset) && args.offset >= 0 && args.offset < descriptor.bytes
        && args.offset % descriptor.pageBytes === 0
    },
    observe(exec, result) {
      if (!locatedCalls.has(exec)) return
      locatedCalls.delete(exec)
      if (result?.isError) return
      let row
      try { row = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('')) } catch { return }
      const d = row?.descriptor
      if (row.ok !== true || d?.readerSessionId !== sessionId || d.sourceRef?.sessionId !== sessionId || d.sourceRef.seq !== seq
        || d.sourceRef.sourceRevision !== seq || typeof d.locator !== 'string' || !/^[a-f0-9]{64}$/.test(d.sourceRef.sourceHash)
        || !/^[a-f0-9]{64}$/.test(d.sourceRef.artifactHash) || d.pairingComplete !== true
        || !Number.isSafeInteger(d.bytes) || d.bytes < 1 || d.bytes > 65536
        || !Number.isSafeInteger(d.pageBytes) || d.pageBytes < 128 || d.pageBytes > 65536
        || d.pages !== Math.ceil(d.bytes / d.pageBytes) || d.pages > 16) return
      descriptors.set(d.locator, structuredClone(d))
    },
  })
}

export function verifyHistoryQualityResult(value, target) {
  try {
    const d = value.descriptor, encoded = Buffer.from(JSON.stringify(value.artifact), 'utf8')
    const expected = Array.from({length:d.pages}, (_, i) => hash(encoded.subarray(i*d.pageBytes, Math.min((i+1)*d.pageBytes, encoded.length))))
    const assembled = value.kind === 'history-raw-artifact-v1' && value.ok === true && value.durable === true
      && typeof value.deliveryCandidate?.id === 'string' && typeof value.deliveryCandidate?.callId === 'string'
      && value.deliveryCandidate.status === 'returned-awaiting-dispatch'
    return (assembled || value.kind === 'exact-history-quality-result') && d.pairingComplete === true
      && d.bytes === encoded.length && hash(encoded) === d.sourceRef.artifactHash
      && d.sourceRef.seq === target.seq && d.sourceRef.sourceHash === hash(JSON.stringify(target))
      && JSON.stringify(value.artifact.target) === JSON.stringify(target)
      && JSON.stringify(value.pageHashes) === JSON.stringify(expected)
      && value.receipt.status === 'full-fetched' && value.receipt.pageCount === d.pages
  } catch { return false }
}
