import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeasurer } from './runner/parity-measure.mjs';
import { createJsonReader, toPosix } from './runner/parity-read.mjs';

/**
 * WP-0 of docs/refactor-20261026/20-M5-plan.md: the parity gate for the test rewrite.
 *
 * The M5 milestone rewrites the test tree. "npm test is green" cannot prove that no assertion was thrown away, so the
 * coverage at HEAD is recorded once (verification/parity-baseline.json) and every later work package has to match it.
 *
 * Per suite (the list is verification/runner/suites.json) the gate compares the test-side file closure, the static
 * assert count and the suite success markers; parity-measure.mjs documents what the closure and the count mean.
 *
 * Usage:
 *   node verification/check-parity.mjs --check            # default; exit 1 on any shrink or mismatch
 *   node verification/check-parity.mjs --print            # same, plus one line per suite
 *   node verification/check-parity.mjs --explain          # print what this metric can and cannot see
 *   node verification/check-parity.mjs --write            # create the baseline; an existing one needs no shrink
 *   node verification/check-parity.mjs --write --accept-growth
 *
 * --write is guarded: with no baseline it creates one. With a baseline it refuses to record any decrease unless
 * verification/parity-exceptions.json carries an entry {suite, field, from, to, reason} for that exact delta, and it
 * refuses to record growth unless --accept-growth is given. A rewrite can never launder a lost assertion into a new
 * baseline by accident.
 *
 * Moved files: verification/runner/parity-moves.json maps {from, to}, where to is a path or an array of paths (a split).
 * The gate rewrites the baseline paths through the map before comparing, and a mapped file must keep exactly the same
 * assertion count (a split keeps the sum). Without a map entry a move reads as a deletion and fails.
 *
 * A move may not invent coverage, so a mapping is rejected ("moves invalid") when: the same from appears twice; a to
 * appears twice inside one move; two moves claim the same to; or a to names a file the baseline already had unless that
 * file is itself a from (a -> b -> c chain). Otherwise one unrelated file's assertions could be counted twice. Both
 * --check and --write reject an invalid mapping.
 *
 * A closure may not reach verification/archive/, runs/ or node_modules/: rule 8 says the default run never scans the
 * archive, and runs/ holds evidence rather than tests.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const suitesPath = path.join(repoRoot, 'verification', 'runner', 'suites.json');
const baselinePath = path.join(repoRoot, 'verification', 'parity-baseline.json');
const movesPath = path.join(repoRoot, 'verification', 'runner', 'parity-moves.json');
const exceptionsPath = path.join(repoRoot, 'verification', 'parity-exceptions.json');

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--check', '--print', '--explain', '--write', '--accept-growth']);
for (const flag of argv) {
  if (!KNOWN_FLAGS.has(flag)) {
    console.error('unknown argument ' + flag + '; known: ' + [...KNOWN_FLAGS].join(' '));
    process.exit(2);
  }
}
const wantPrint = argv.includes('--print');
const wantExplain = argv.includes('--explain');
const wantWrite = argv.includes('--write');
const acceptGrowth = argv.includes('--accept-growth');

const traceReads = process.env.DSH_PARITY_TRACE_READS === '1';
const { measure, countAsserts, relOf, isForbidden, guardedRead } = createMeasurer(repoRoot, {
  onRead: traceReads ? file => console.error('read ' + file) : null
});

// The gate's own configuration files go through the same guarded reader as everything else.
const readJson = createJsonReader({ repoRoot, guardedRead });

const manifest = readJson(suitesPath);
const suites = manifest.suites;
if (!Array.isArray(suites) || suites.length === 0) {
  console.error('verification/runner/suites.json has no suites');
  process.exit(2);
}
const ids = suites.map(suite => suite.id);
const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
if (duplicate) {
  console.error('duplicate suite id in suites.json: ' + duplicate);
  process.exit(2);
}

const moves = (readJson(movesPath, { moves: [] }).moves ?? []).map(entry => ({
  from: toPosix(entry.from),
  to: (Array.isArray(entry.to) ? entry.to : [entry.to]).map(toPosix)
}));
// A suite split (WP-4): one baseline suite becomes several suites, and the parts must add up to the whole. The mapping is
// inert once --write has recorded the parts, exactly like a move whose from is no longer in the baseline.
const splits = (readJson(movesPath, { moves: [] }).splits ?? []).map(entry => ({
  from: toPosix(entry.from),
  to: (Array.isArray(entry.to) ? entry.to : [entry.to]).map(toPosix)
}));
const moveMap = new Map(moves.map(entry => [entry.from, entry.to]));
const exceptions = readJson(exceptionsPath, { exceptions: [] }).exceptions ?? [];

const { measured, missing, forbidden } = measure(suites);
if (missing.length > 0) {
  console.error('suite entry files that do not exist:');
  for (const line of missing) console.error('  ' + line);
  process.exit(1);
}

const baseline = fs.existsSync(baselinePath) ? readJson(baselinePath) : null;

/**
 * A move may not invent coverage. Each target must be a distinct path that no other move already claims, and a target
 * may not name a file the baseline already had unless that file is itself a from (a chain a -> b -> c). A duplicate
 * target would let one unrelated file's assertions be counted twice.
 */
function validateMoves() {
  const messages = [];
  const invalid = new Set();
  const baselineFiles = new Set();
  for (const suite of Object.values(baseline?.suites ?? {})) for (const file of suite.files) baselineFiles.add(file);
  const froms = new Set(moves.map(move => move.from));
  const seenFrom = new Set();
  const claimed = new Map();
  for (const move of moves) {
    const before = messages.length;
    if (seenFrom.has(move.from)) messages.push('duplicate from: ' + move.from);
    seenFrom.add(move.from);
    const within = new Set();
    for (const target of move.to) {
      if (within.has(target)) messages.push('duplicate to inside one move: ' + target + ' (from ' + move.from + ')');
      within.add(target);
      if (target === move.from) messages.push('to equals from: ' + target);
      if (claimed.has(target) && claimed.get(target) !== move.from) {
        messages.push('to shared by two moves: ' + target + ' (' + claimed.get(target) + ', ' + move.from + ')');
      }
      claimed.set(target, move.from);
      if (baselineFiles.has(target) && !froms.has(target)) {
        messages.push('to already exists in the baseline and is not a from: ' + target);
      }
      if (isForbidden(target)) messages.push('to is a path that is never scanned: ' + target);
    }
    // A mapping that breaks a rule is never counted: counting it is how a forbidden target would get read.
    if (messages.length > before) invalid.add(move.from);
  }
  return { messages, invalid };
}

/** A split is only meaningful while its source still owns a baseline; targets may not be invented or duplicated. */
function validateSplits() {
  const messages = [];
  const inactive = new Set();
  const invalid = new Set();
  const baselineIds = new Set(Object.keys(baseline?.suites ?? {}));
  const suiteIds = new Set(suites.map(suite => suite.id));
  const seenFrom = new Set();
  const claimed = new Set();
  for (const split of splits) {
    const before = messages.length;
    if (seenFrom.has(split.from)) messages.push('duplicate split from: ' + split.from);
    seenFrom.add(split.from);
    if (baseline && !baselineIds.has(split.from)) { inactive.add(split.from); continue; }
    for (const target of split.to) {
      if (claimed.has(target)) messages.push('suite claimed by two splits: ' + target);
      claimed.add(target);
      if (!suiteIds.has(target)) messages.push('split target is not a suite: ' + target);
      // The source may keep one part of itself; any other target with a baseline would double-count.
      if (target !== split.from && baselineIds.has(target)) {
        messages.push('split target already has a baseline: ' + target + ' (from ' + split.from + ')');
      }
    }
    if (messages.length > before) invalid.add(split.from);
  }
  return { messages, inactive, invalid };
}

/** Rewrite baseline paths through the move map: a moved file is expected at its new path, a split at all its parts. */
function expandMoves(files, map) {
  const out = new Set();
  for (const file of files) {
    const targets = map.get(file);
    if (targets) for (const target of targets) out.add(target);
    else out.add(file);
  }
  return out;
}

const exceptionFor = (suiteId, field, from, to) => exceptions.find(entry => entry.suite === suiteId &&
  entry.field === field && entry.from === from && entry.to === to && String(entry.reason ?? '').trim() !== '');

const exceptionHint = (id, from, to) =>
  '{"suite":"' + id + '","field":"asserts","from":' + from + ',"to":' + to + ',"reason":"<why this is not a loss>"}' +
  ' to verification/parity-exceptions.json';

const countIfPresent = file => {
  if (!fs.existsSync(path.join(repoRoot, file))) return null;
  try {
    return countAsserts(file);
  } catch (error) {
    if (error.code === 'PARITY_FORBIDDEN') return null;
    throw error;
  }
};

/** Decreases, growths and unexplained file removals between the baseline and the tree, move map applied. */
function reconcile() {
  const problems = [];
  const notes = [];
  const movesState = validateMoves();
  for (const message of movesState.messages) problems.push('moves invalid: ' + message);
  const splitState = validateSplits();
  for (const message of splitState.messages) problems.push('splits invalid: ' + message);
  const activeSplits = splits.filter(split => !splitState.inactive.has(split.from) && !splitState.invalid.has(split.from));
  const splitSources = new Set(activeSplits.map(split => split.from));
  const splitTargets = new Set(activeSplits.flatMap(split => split.to));
  for (const file of forbidden) problems.push('suite depends on a path that is never scanned: ' + file);
  const activeMoves = moves.filter(move => !movesState.invalid.has(move.from));
  const activeMap = new Map(activeMoves.map(move => [move.from, move.to]));

  const baselineIds = Object.keys(baseline.suites ?? {});
  for (const id of baselineIds) if (!measured.has(id) && !splitSources.has(id)) problems.push('suite removed from suites.json: ' + id);
  for (const id of measured.keys()) if (!baselineIds.includes(id) && !splitTargets.has(id)) problems.push('suite without baseline: ' + id);

  for (const move of activeMoves) {
    const fromCount = Object.values(baseline.suites)
      .map(suite => suite.fileAsserts?.[move.from]).find(count => typeof count === 'number');
    if (typeof fromCount === 'number') {
      const toCount = move.to.reduce((sum, file) => sum + (countIfPresent(file) ?? 0), 0);
      if (toCount !== fromCount) {
        problems.push('move ' + move.from + ' -> ' + move.to.join(' + ') + ' asserts ' + toCount + '/' + fromCount);
      }
    }
    for (const file of move.to) {
      if (!fs.existsSync(path.join(repoRoot, file))) problems.push('move target is missing: ' + file);
    }
  }

  for (const suite of suites) {
    if (splitSources.has(suite.id) || splitTargets.has(suite.id)) continue;
    const current = measured.get(suite.id);
    const base = baseline.suites?.[suite.id];
    if (!base || current.skipped) continue;
    if (JSON.stringify(current.markers) !== JSON.stringify(base.markers)) {
      problems.push(suite.id + ': success markers changed (' + base.markers.join(' + ') + ' -> ' +
        current.markers.join(' + ') + ')');
    }
    const delta = current.asserts - base.asserts;
    if (delta < 0) {
      const exception = exceptionFor(suite.id, 'asserts', base.asserts, current.asserts);
      if (exception) notes.push(suite.id + ': asserts ' + base.asserts + ' -> ' + current.asserts + ' (exempt: ' +
        exception.reason + ')');
      else {
        problems.push(suite.id + ': asserts ' + current.asserts + '/' + base.asserts + ' (' + delta + '); add ' +
          exceptionHint(suite.id, base.asserts, current.asserts));
      }
    } else if (delta > 0) {
      notes.push(suite.id + ': asserts ' + current.asserts + '/' + base.asserts + ' (+' + delta + ', growth)');
    }
    const expected = expandMoves(base.files, activeMap);
    const removed = [...expected].filter(file => !current.files.includes(file));
    const added = current.files.filter(file => !expected.has(file) && !activeMap.has(file));
    if (removed.length > 0) problems.push(suite.id + ': files gone from the closure: ' + removed.join(', '));
    if (added.length > 0) notes.push(suite.id + ': files added: ' + added.join(', '));
  }

  // A split is compared as one unit: the union of the parts must carry every file the source had and the sum of their
  // assertions must equal the source's, so a file cannot disappear between the parts.
  for (const split of activeSplits) {
    const base = baseline.suites?.[split.from];
    if (!base) continue;
    const parts = split.to.map(id => measured.get(id)).filter(Boolean);
    const asserts = parts.reduce((sum, part) => sum + part.asserts, 0);
    const files = new Set(parts.flatMap(part => part.files));
    const delta = asserts - base.asserts;
    if (delta < 0) {
      const exception = exceptionFor(split.from, 'asserts', base.asserts, asserts);
      if (exception) notes.push(split.from + ' split: asserts ' + base.asserts + ' -> ' + asserts + ' (exempt: ' + exception.reason + ')');
      else problems.push(split.from + ' split: asserts ' + asserts + '/' + base.asserts + ' (' + delta + '); add ' + exceptionHint(split.from, base.asserts,
          asserts));
    } else if (delta > 0) {
      notes.push(split.from + ' split: asserts ' + asserts + '/' + base.asserts + ' (+' + delta + ', growth)');
    }
    const expected = expandMoves(base.files, activeMap);
    const removed = [...expected].filter(file => !files.has(file));
    const added = [...files].filter(file => !expected.has(file) && !activeMap.has(file));
    if (removed.length > 0) problems.push(split.from + ' split: files gone from the closure: ' + removed.join(', '));
    if (added.length > 0) notes.push(split.from + ' split: files added: ' + added.join(', '));
    for (const id of split.to) {
      const part = measured.get(id);
      if (part && JSON.stringify(part.markers) !== JSON.stringify(base.markers)) {
        problems.push(id + ': success markers changed (' + base.markers.join(' + ') + ' -> ' + part.markers.join(' + ') + ')');
      }
    }
  }
  return { problems, notes, activeSplits, growth: notes.filter(note => note.includes(', growth)')) };
}

if (wantWrite) {
  if (baseline) {
    const { problems, growth } = reconcile();
    // A suite that is new to the manifest is growth, not a loss: --accept-growth records it in the baseline.
    const blockers = acceptGrowth ? problems.filter(p => !p.startsWith('suite without baseline: ')) : [...problems];
    if (growth.length > 0 && !acceptGrowth) blockers.push('growth needs --accept-growth: ' + growth.join('; '));
    if (blockers.length > 0) {
      for (const blocker of blockers) console.error('WRITE REFUSED: ' + blocker);
      console.error('The existing baseline is kept. Record the loss in verification/parity-exceptions.json or, for' +
        ' intended growth, re-run with --write --accept-growth.');
      process.exit(1);
    }
  }
  const recorded = {
    '$comment': [
      'WP-0 baseline of docs/refactor-20261026/20-M5-plan.md; write with node verification/check-parity.mjs --write.',
      'files/asserts/fileAsserts/markers are checked by check-parity; tests is recorded only.',
      'tests = node:test "# pass N" of one green TAP run per node:test suite; null for script suites (markers instead).'
    ],
    totals: {},
    suites: {}
  };
  let totalAsserts = 0;
  let totalFiles = 0;
  for (const suite of suites) {
    const current = measured.get(suite.id);
    recorded.suites[suite.id] = {
      layer: current.layer,
      files: current.files,
      fileAsserts: current.fileAsserts,
      asserts: current.asserts,
      markers: current.markers,
      tests: baseline?.suites?.[suite.id]?.tests ?? null
    };
    totalAsserts += current.asserts;
    totalFiles += current.files.length;
  }
  recorded.totals = { suites: suites.length, asserts: totalAsserts, files: totalFiles };
  fs.writeFileSync(baselinePath, JSON.stringify(recorded, null, 2) + '\n');
  console.log('wrote ' + relOf(baselinePath) + ': suites=' + suites.length + ' asserts=' + totalAsserts +
    ' files=' + totalFiles);
  process.exit(0);
}

if (!baseline) {
  console.error('no baseline at ' + relOf(baselinePath) + '; create it with --write');
  process.exit(2);
}

const { problems, notes, activeSplits } = reconcile();
const baselineIds = Object.keys(baseline.suites ?? {});
const nowAsserts = [...measured.values()].reduce((sum, suite) => sum + suite.asserts, 0);
const baseAssertTotal = Object.values(baseline.suites).reduce((sum, suite) => sum + suite.asserts, 0);
const nowFiles = [...measured.values()].reduce((sum, suite) => sum + suite.files.length, 0);
const baseFileTotal = Object.values(baseline.suites).reduce((sum, suite) => sum + suite.files.length, 0);
// A renamed suite is backed by its split source; a rejected split never maps a suite back to a baseline.
const splitBase = new Map(activeSplits.flatMap(split => split.to.map(target => [target, split.from])));
const markerOk = suites.filter(suite => {
  const base = baseline.suites[splitBase.get(suite.id) ?? suite.id], current = measured.get(suite.id);
  return Boolean(base && current) && JSON.stringify(current.markers) === JSON.stringify(base.markers);
}).length;
const total = Math.max(baselineIds.length, measured.size);

// Notes (growth, exemptions, added files) are always shown: they are the visible half of an otherwise quiet gate.
for (const note of notes) console.log(note);

if (wantPrint || problems.length > 0) {
  if (wantPrint) {
    for (const suite of suites) {
      const current = measured.get(suite.id);
      const base = baseline.suites?.[suite.id];
      const tests = typeof base?.tests === 'number' ? ' tests~' + base.tests : '';
      console.log('  ' + suite.id.padEnd(34) + String(current.layer).padEnd(12) + 'asserts ' + current.asserts +
        '/' + (base?.asserts ?? '?') + '  files ' + current.files.length + '/' + (base?.files.length ?? '?') + tests);
    }
  }
}

const summary = 'parity: suites=' + (total - problems.filter(p => p.includes('suite ')).length) + '/' + total +
  ' asserts=' + nowAsserts + '/' + baseAssertTotal + ' files=' + nowFiles + '/' + baseFileTotal +
  ' markers=' + markerOk + '/' + total + ' tests=recorded';

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error('PARITY FAIL: ' + problem);
  console.error('');
  console.error(summary + ' (failed)');
  console.error('A lost assertion is never repaired by re-running --write: record it in verification/parity-exceptions.json' +
    ' ({"suite","field","from","to","reason"}) or restore the assertion.');
  process.exit(1);
}

console.log(summary);

if (wantExplain) {
  const lines = [
    '',
    'How to read these numbers:',
    '  asserts counts assert.<name> and assert( call sites in source. A helper called ten times counts once, an assert',
    '  that no longer runs still counts, and expect(...) style assertions are not counted at all.',
    '  files is a closure over relative imports and over script literals that sit next to a spawn call, of test-side',
    '  files only. A path built by concatenation (script + "probe.mjs") is invisible to it.',
    '  markers is the suite success evidence: a suite can keep every assert and still lose coverage by dropping the',
    '  evidence that those asserts ran, which is why it is compared.',
    '  moves are declared in verification/runner/parity-moves.json; a mapped file must keep its assertion count and a',
    '  split must keep the sum. Without a map entry a move reads as a deletion, and an ambiguous mapping is rejected.',
    '  tests is recorded from one TAP run per node:test suite and is never recomputed here.'
  ];
  for (const line of lines) console.log(line);
}
process.exit(0);
