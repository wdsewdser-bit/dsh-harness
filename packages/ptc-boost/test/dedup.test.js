import test from "node:test";
import assert from "node:assert/strict";
import { blockOf, diffWindow, planReplacement, scanSegments, summaryLine } from "../lib/dedup.js";

const mkLines = (from, count, mutate) =>
  Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return { number: n, text: mutate && mutate[n] !== undefined ? mutate[n] : `const value${n} = compute(${n}); // padding text` };
  });

const mkRead = (from, count, mutate) => {
  const lines = mkLines(from, count, mutate);
  return { key: "d:/w/app.js", label: "D:/w/app.js", offset: from, endLine: from + count - 1, totalLines: 200, lines };
};

const config = { minReplaceChars: 300, minSeenRatio: 0.5, maxChangedRatio: 0.3, maxDiffRatio: 0.5, maxDiffChars: 4000 };
const entryOf = (pairs) => ({ lines: new Map(pairs), total: 200 });

test("a whole printed read block is found; a slice is not", () => {
  const read = mkRead(1, 20);
  const whole = blockOf(read.lines);
  const segments = scanSegments("prefix\n" + whole + "\nsuffix", [read]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].read, read);
  assert.equal(segments[0].start, 7);
  assert.equal(segments[0].end, 7 + whole.length);

  const slice = read.lines.slice(0, 5).map((l) => l.text).join("\n");
  assert.deepEqual(scanSegments(slice, [read]), []);
});

test("a re-numbered or joined-per-line print is not a match", () => {
  const read = mkRead(1, 10);
  const numbered = read.lines.map((l) => `${l.number}| ${l.text}`).join("\n");
  assert.deepEqual(scanSegments(numbered, [read]), []);
  const joined = read.lines.map((l) => l.text).join(" ");
  assert.deepEqual(scanSegments(joined, [read]), []);
  const filtered = read.lines.filter((l) => l.number % 2 === 0).map((l) => l.text).join("\n");
  assert.deepEqual(scanSegments(filtered, [read]), []);
});

test("only the complete, contiguous run counts", () => {
  const read = mkRead(1, 5);
  const missingMiddle = [read.lines[0], read.lines[1], read.lines[3], read.lines[4]].map((l) => l.text).join("\n");
  assert.deepEqual(scanSegments(missingMiddle, [read]), []);
  const reversed = [...read.lines].reverse().map((l) => l.text).join("\n");
  assert.deepEqual(scanSegments(reversed, [read]), []);
});

test("two reads of the same text are replaced once (leftmost-longest)", () => {
  const a = mkRead(1, 5);
  const b = mkRead(1, 5);
  b.key = "d:/w/b.js";
  const text = blockOf(a.lines);
  const segments = scanSegments(text, [a, b]);
  assert.equal(segments.length, 1);
});

test("CRLF output still matches", () => {
  const read = mkRead(1, 4);
  const text = read.lines.map((l) => l.text).join("\r\n");
  const segments = scanSegments(text, [read]);
  assert.equal(segments.length, 1);
});

test("unchanged content already seen becomes a notice", () => {
  const read = mkRead(1, 20);
  const entry = entryOf(read.lines.map((l) => [l.number, l.text]));
  const plan = planReplacement(entry, read, 1000, config);
  assert.equal(plan.kind, "notice");
  assert.ok(plan.text.startsWith("[read-dedup]"));
  assert.ok(plan.text.includes("already printed in this session"));
  assert.ok(plan.savedChars > 0);
});

test("a changed range becomes a diff", () => {
  const read = mkRead(1, 20, { 7: "const value7 = compute(7); // CHANGED padding text" });
  const entry = entryOf(mkLines(1, 20).map((l) => [l.number, l.text]));
  const plan = planReplacement(entry, read, 1000, config);
  assert.equal(plan.kind, "diff");
  assert.ok(plan.text.includes("- 7: const value7 = compute(7); // padding text"));
  assert.ok(plan.text.includes("+ 7: const value7 = compute(7); // CHANGED padding text"));
  assert.ok(plan.text.includes("changed since it was printed"));
});

test("no record, no overlap or partial overlap keeps the text", () => {
  const read = mkRead(1, 20);
  assert.equal(planReplacement(undefined, read, 1000, config).kind, "full");
  assert.equal(planReplacement(entryOf([]), read, 1000, config).kind, "full");
  const partly = entryOf(mkLines(1, 4).map((l) => [l.number, l.text]));
  assert.equal(planReplacement(partly, read, 1000, config).kind, "full");
});

test("too many changed lines keeps the text", () => {
  const mutate = {};
  for (let n = 1; n <= 20; n += 1) mutate[n] = `const value${n} = compute(${n}); // rewritten`;
  const read = mkRead(1, 20, mutate);
  const entry = entryOf(mkLines(1, 20).map((l) => [l.number, l.text]));
  const plan = planReplacement(entry, read, 1000, config);
  assert.equal(plan.kind, "full");
  assert.equal(plan.reason, "changed-too-much");
});

test("a diff that is not smaller keeps the text", () => {
  const read = mkRead(1, 20, { 3: "x".repeat(200) });
  const entry = entryOf(mkLines(1, 20).map((l) => [l.number, l.text]));
  const plan = planReplacement(entry, read, 320, config);
  assert.equal(plan.kind, "full");
});

test("diffWindow summarises prefix and suffix", () => {
  const old = mkLines(1, 10);
  const fresh = mkLines(1, 10, { 5: "changed line" });
  const entry = entryOf(old.map((l) => [l.number, l.text]));
  const read = { key: "k", label: "L", offset: 1, endLine: 10, totalLines: 10, lines: fresh };
  const diff = diffWindow(entry, read, { maxChars: 4000 });
  assert.equal(diff.prefix, 4);
  assert.equal(diff.suffix, 5);
  assert.equal(diff.rows.length, 2);
});

test("summaryLine reports the run and the session", () => {
  const line = summaryLine({ hits: 2, savedChars: 1234 }, { hits: 5, savedChars: 9999 });
  assert.ok(line.startsWith("[read-dedup] this program: 2 segment(s)"));
  assert.ok(line.includes("1234 chars saved"));
  assert.ok(line.includes("session total: 5 hit(s) / 9999 chars"));
});
