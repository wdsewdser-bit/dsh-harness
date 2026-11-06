import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Anchor discovery for the instant-preempt candidate (C2).
 *
 * The published package ships compiled lib/ only, so the patch can never be written from remembered line
 * numbers. This script proves every structure the candidate replaces still exists with the expected
 * multiplicity, stores the exact source text of each edit window in anchors.json, and aborts on any miss.
 * apply.mjs then patches from those literal strings only, so a moved or rewritten structure is ANCHOR_DRIFT
 * instead of a silent bad edit.
 */
export const BUILD = '<path-to-dsh-upstream-0.2.2-alpha.2>/install';
export const BUILD_C2 = '<path-to-dsh-c2-build-0.2.2>';
export const AGENT_LOOP = 'node_modules/@deepseek-ai/dsh-agent-loop';
export const TARGET_REL = AGENT_LOOP + '/lib/index.js';
export const TYPES_REL = AGENT_LOOP + '/lib/types/index.d.ts';

export const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** The checklist's four probes, kept verbatim so the report shows what they actually match in this build. */
export const CHECKLIST_PROBES = {
  streamRead: /for\s*(?:await)?\s*\(\s*const\s+\w+\s+of\s+.*stream/,
  stepEntry: /async\s*\*\s*step\s*\(|step\s*\(\s*agent/,
  preStepDispatch: /agent\/pre-step/,
  abortSurface: /abort|cancel/i,
};

/**
 * Structures the candidate depends on. 'count' is the exact multiplicity: 1 means "present and unique", 2
 * means the candidate deliberately rewrites both occurrences. Anything else is drift.
 */
export const REQUIRED = {
  stepMethod: { pattern: /^\tasync step\(decision\) \{$/, count: 1 },
  stepBodyHead: { pattern: /^\t\tconst \{ turn, step, abort: \{ signal \} \} = this\.phase;$/, count: 1 },
  streamReadLoop: { pattern: /^\t+for await \(const chunk of stream\) \{$/, count: 1 },
  interruptedSettlement: { pattern: /^\t+if \(signal\.aborted\) \{$/, count: 1 },
  turnStepCall: { pattern: /^\t+const stepEnd = await this\.step\(decision\);$/, count: 1 },
  configSchema: { pattern: /^\tstatic Config = z\.object\(\{$/, count: 1 },
  loopConfigBuild: { pattern: /^\t\tthis\.config = \{$/, count: 1 },
  phaseField: { pattern: /^\tphase;$/, count: 1 },
  cancelAbort: { pattern: /^\t\tif \(this\.phase\.kind !== "idle"\) this\.phase\.abort\.abort\(cause\);$/, count: 1 },
  cancelMethod: { pattern: /^\tcancel\(cause, options = \{\}\) \{$/, count: 1 },
  phaseInit: { pattern: /^\t\tthis\.phase = \{$/, count: 1 },
  preStepWaterfall: { pattern: /const decision = await this\.dispatch\.waterfall\("agent\/pre-step"/, count: 1 },
  streamAttemptClass: { pattern: /^var AssistantStreamAttempt = class \{$/, count: 1 },
  finishLine: { pattern: /^\t+const finish = live\.finish;$/, count: 1 },
  typesConfigField: { pattern: /^    maxParallelToolCalls: Volatile<number>;$/, count: 1, file: 'types' },
  typesConfigDoc: { pattern: /^\/\*\* Concrete agent factory and driver service\. \*\/$/, count: 1, file: 'types' },
  typesStaticConfig: { pattern: /^        maxParallelToolCalls\?: number;$/, count: 1, file: 'types' },
};

/** Edit windows: literal source text apply.mjs replaces, resolved from a unique anchor line plus offsets. */
export const WINDOWS = {
  stepBodyHead: { anchor: 'stepBodyHead', from: 0, to: 1 },
  streamLoop: { anchor: 'streamReadLoop', from: -4, to: 4 },
  streamCatch: { anchor: 'interruptedSettlement', from: -3, to: 0 },
  turnStepCall: { anchor: 'turnStepCall', from: 0, to: 1 },
  configField: { anchor: 'configSchema', from: 1, to: 1 },
  loopConfig: { anchor: 'loopConfigBuild', from: 0, to: 3 },
  phaseField: { anchor: 'phaseField', from: 0, to: 0 },
  cancelAbort: { anchor: 'cancelAbort', from: 0, to: 0 },
  cancelMethod: { anchor: 'cancelMethod', from: 0, to: 0 },
  finishLine: { anchor: 'finishLine', from: 0, to: 0 },
  finishOpen: { anchor: 'finishLine', from: -1, to: 0 },
  typesDoc: { anchor: 'typesConfigDoc', from: 0, to: 0, file: 'types' },
  typesConfigField: { anchor: 'typesConfigField', from: 0, to: 0, file: 'types' },
  typesStaticConfig: { anchor: 'typesStaticConfig', from: 0, to: 0, file: 'types' },
};

export function scan(file, lines) {
  const found = {};
  const problems = [];
  for (const [id, spec] of Object.entries(REQUIRED)) {
    if ((spec.file ?? 'index') !== file) continue;
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (spec.pattern.test(lines[i])) hits.push(i + 1);
    found[id] = hits;
    if (hits.length !== spec.count) problems.push({ id, expected: spec.count, actual: hits.length });
  }
  return { found, problems };
}

export function discover(build = BUILD) {
  const target = build + '/' + TARGET_REL;
  const types = build + '/' + TYPES_REL;
  const source = fs.readFileSync(target, 'utf8');
  const typeSource = fs.readFileSync(types, 'utf8');
  const lines = source.split('\n');
  const typeLines = typeSource.split('\n');
  const index = scan('index', lines);
  const typeScan = scan('types', typeLines);
  const problems = [...index.problems, ...typeScan.problems];
  const all = { ...index.found, ...typeScan.found };
  const checklist = Object.fromEntries(Object.entries(CHECKLIST_PROBES).map(([id, pattern]) => [id,
    lines.reduce((hits, line, i) => (pattern.test(line) ? [...hits, i + 1] : hits), [])]));
  const blocks = {};
  for (const [name, window] of Object.entries(WINDOWS)) {
    const anchors = all[window.anchor] ?? [];
    if (anchors.length !== 1) continue;
    const fileLines = (window.file ?? 'index') === 'types' ? typeLines : lines;
    const start = anchors[0] - 1 + window.from;
    const end = anchors[0] - 1 + window.to;
    if (start < 0 || end >= fileLines.length) continue;
    blocks[name] = { file: window.file ?? 'index', start: start + 1, end: end + 1,
      text: fileLines.slice(start, end + 1).join('\n'), occurrences: 0 };
  }
  return { source, typeSource, lines, typeLines, found: all, problems, checklist, blocks };
}

const run = () => {
  const { found, problems, checklist, blocks, source, typeSource } = discover();
  for (const block of Object.values(blocks)) {
    const haystack = block.file === 'types' ? typeSource : source;
    block.occurrences = haystack.split(block.text).length - 1;
  }
  const nonUnique = Object.entries(blocks).filter(([, b]) => b.occurrences !== 1).map(([name]) => name);
  const missingBlocks = Object.keys(WINDOWS).filter(name => blocks[name] === undefined);
  const report = {
    build: BUILD,
    target: BUILD + '/' + TARGET_REL,
    types: BUILD + '/' + TYPES_REL,
    preimage: { indexJs: sha256(BUILD + '/' + TARGET_REL), typesDts: sha256(BUILD + '/' + TYPES_REL) },
    checklistProbes: checklist,
    checklistNote: 'The checklist step probe expected a generator (async *step) or step(agent); this build declares async step(decision), so that probe matches nothing. The candidate therefore anchors on the verified declaration shapes recorded in anchors, each confirmed unique or exactly doubled.',
    anchors: Object.fromEntries(Object.entries(found).map(([id, hits]) => [id, hits])),
    problems,
    blocks: Object.fromEntries(Object.entries(blocks).map(([name, b]) => [name, { file: b.file, start: b.start, end: b.end, occurrences: b.occurrences, text: b.text }])),
    missingBlocks,
    nonUnique,
  };
  fs.writeFileSync(new URL('./anchors.json', import.meta.url), JSON.stringify(report, null, 2));
  const ok = !problems.length && !missingBlocks.length && !nonUnique.length;
  console.log(JSON.stringify({ ok, problems, missingBlocks, nonUnique,
    blocks: Object.fromEntries(Object.entries(blocks).map(([n, b]) => [n, b.start + '-' + b.end])),
    preimage: report.preimage }, null, 2));
  if (!ok) {
    console.error('ANCHOR_DRIFT: required structures missing, ambiguous, or duplicated; refusing to patch');
    process.exitCode = 1;
  }
};

const asPath = p => p.replaceAll('\\', '/').toLowerCase();
if (process.argv[1] && asPath(fileURLToPath(import.meta.url)) === asPath(process.argv[1])) run();