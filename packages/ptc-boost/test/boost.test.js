import test from "node:test";
import assert from "node:assert/strict";
import { createBoost, parseReadValue, sessionIdOf, textOfContent } from "../lib/boost.js";

const SESSION = { id: "session-1" };
const agent = { session: SESSION };
const FILE = "D:/w/app.js";

const fileLines = (count, mutate) =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return mutate && mutate[n] !== undefined ? mutate[n] : `const value${n} = compute(${n}); // padding padding`;
  });

const readValue = (texts, offset = 1, totalLines = 200, path = FILE) => ({
  path,
  offset,
  lines: texts.map((text, i) => ({ number: offset + i, text })),
  totalLines,
});

let callSeq = 0;

/** Simulate one run_code program: its reads, then its printed output. */
function program(boost, reads, output) {
  callSeq += 1;
  const callId = "c" + callSeq;
  for (const read of reads) {
    boost.postExecute(
      { name: "read", parent: Symbol("parent"), callId: callId + "-" + Math.random(), rootCallId: callId, arguments: { file_path: read.value.path }, agent },
      { isError: false, value: read.value, content: [{ type: "text", text: "<rendered>" }] },
    );
  }
  return boost.postExecute(
    { name: "run_code", callId, rootCallId: callId, agent },
    { isError: false, value: { logs: [output] }, content: [{ type: "text", text: output }] },
  );
}

const textOf = (replacement) => (replacement === undefined ? undefined : replacement.content[0].text);

test("a read result is never modified: the program always gets the real text", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  const result = { isError: false, value, content: [{ type: "text", text: "<rendered>" }] };
  // first read, second read, third read — all untouched, even after a hit elsewhere
  assert.equal(boost.postExecute({ name: "read", parent: Symbol(), callId: "n1", rootCallId: "c-x", arguments: { file_path: FILE }, agent }, result),
    undefined);
  assert.equal(boost.postExecute({ name: "read", parent: Symbol(), callId: "n2", rootCallId: "c-x", arguments: { file_path: FILE }, agent }, result),
    undefined);
  program(boost, [{ value }], texts.join("\n"));
  assert.equal(boost.postExecute({ name: "read", parent: Symbol(), callId: "n3", rootCallId: "c-y", arguments: { file_path: FILE }, agent }, result),
    undefined);
  // the canonical value the program receives is still the real one
  assert.equal(value.lines.length, 60);
  assert.equal(value.lines[0].text, texts[0]);
});

test("a whole read printed a second time becomes one line plus a summary", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  const first = program(boost, [{ value }], texts.join("\n"));
  assert.equal(first, undefined, "first print is left alone");
  const second = program(boost, [{ value }], texts.join("\n"));
  const out = textOf(second);
  assert.ok(out, "second print is replaced");
  assert.ok(out.startsWith("[read-dedup] " + FILE + ": lines 1-60 of 200"));
  assert.ok(out.includes("already printed in this session"));
  assert.ok(out.includes("[read-dedup] this program: 1 segment(s) replaced"));
  assert.ok(out.length < 400);
  assert.equal(boost.stats.dedup.hits, 1);
  assert.ok(boost.stats.dedup.savedChars > 1000);
});

test("printing only a slice is not deduplicated", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  program(boost, [{ value }], texts.join("\n"));
  const slice = texts.slice(10, 20).join("\n");
  assert.equal(program(boost, [{ value }], slice), undefined);
  assert.equal(boost.stats.dedup.hits, 0);
});

test("printing with line numbers or filtered is not deduplicated", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  program(boost, [{ value }], texts.join("\n"));
  const numbered = value.lines.map((l) => `${l.number}|${l.text}`).join("\n");
  assert.equal(program(boost, [{ value }], numbered), undefined);
  const filtered = value.lines.filter((l) => l.number % 2 === 0).map((l) => l.text).join("\n");
  assert.equal(program(boost, [{ value }], filtered), undefined);
  assert.equal(boost.stats.dedup.hits, 0);
});

test("a changed file becomes a diff, not a notice", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  program(boost, [{ value: readValue(texts) }], texts.join("\n"));
  const changed = texts.slice();
  changed[19] = "const value20 = compute(20); // MUTATED padding";
  const out = textOf(program(boost, [{ value: readValue(changed) }], changed.join("\n")));
  assert.ok(out.includes("[read-dedup] " + FILE + ": lines 1-60 of 200 changed since it was printed"));
  assert.ok(out.includes("- 20: " + texts[19]));
  assert.ok(out.includes("+ 20: " + changed[19]));
  assert.ok(out.includes("19 leading, 40 trailing lines unchanged"));
});

test("dedup runs before truncation: collapsed reads do not spend the output cap", () => {
  const boost = createBoost({});
  const files = ["D:/w/a.js", "D:/w/b.js", "D:/w/c.js"].map((path) => {
    const texts = fileLines(60);
    return { path, texts, value: readValue(texts, 1, 60, path) };
  });
  for (const file of files) {
    assert.equal(program(boost, [{ value: file.value }], file.texts.join("\n")), undefined, "each file is shown in full first");
  }
  // one program printing all three: ~9 KB before dedup, tiny after
  const reads = files.map((file) => ({ value: file.value }));
  const out = textOf(program(boost, reads, files.map((file) => file.texts.join("\n")).join("\n")));
  assert.ok(out, "the combined output is rewritten");
  assert.equal(out.match(/\[read-dedup\] D:\/w\/[abc]\.js: lines 1-60 of 60/g).length, 3);
  assert.equal(out.includes("Output truncated"), false, "nothing left to truncate");
  assert.equal(boost.refs.size(), 0, "no ref: dedup ran before the cap");
});

test("lines dropped by truncation are not recorded as seen", () => {
  const boost = createBoost({});
  const texts = fileLines(400);
  const value = readValue(texts, 1, 400);
  // first program: output truncated, the read's tail falls into the dropped middle
  const first = textOf(program(boost, [{ value }], texts.join("\n")));
  assert.ok(first.includes("Output truncated"));
  // second program prints the same 400 lines: not fully shown before, so no dedup
  // (truncation still applies, with a fresh ref)
  const second = textOf(program(boost, [{ value }], texts.join("\n")));
  assert.ok(second.includes("Output truncated"));
  assert.equal(second.includes("[read-dedup]"), false);
  // a small range that WAS shown verbatim in the first output (the head) dedups
  const head = readValue(texts.slice(0, 30), 1, 400);
  const third = program(boost, [{ value: head }], texts.slice(0, 30).join("\n"));
  assert.ok(textOf(third).includes("[read-dedup] " + FILE + ": lines 1-30 of 400"));
});

test("compaction forgets what was shown", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  program(boost, [{ value }], texts.join("\n"));
  assert.ok(textOf(program(boost, [{ value }], texts.join("\n"))));
  boost.onSessionEvent(SESSION, { type: "compaction/end" });
  assert.equal(program(boost, [{ value }], texts.join("\n")), undefined);
});

test("a fresh process has no memory of the earlier output", () => {
  const texts = fileLines(60);
  const value = readValue(texts);
  const first = createBoost({});
  program(first, [{ value }], texts.join("\n"));
  const fresh = createBoost({});
  assert.equal(program(fresh, [{ value }], texts.join("\n")), undefined);
});

test("dedup off leaves the output byte-identical", () => {
  const boost = createBoost({ dedup: { enabled: false } });
  const texts = fileLines(60);
  const value = readValue(texts);
  program(boost, [{ value }], texts.join("\n"));
  assert.equal(program(boost, [{ value }], texts.join("\n")), undefined);
  assert.equal(boost.stats.dedup.hits, 0);
  assert.equal(boost.stats.dedup.savedChars, 0);
});

test("a small printed run is never replaced", () => {
  const boost = createBoost({});
  const texts = fileLines(4); // < 300 chars
  const value = readValue(texts, 1, 4);
  program(boost, [{ value }], texts.join("\n"));
  assert.equal(program(boost, [{ value }], texts.join("\n")), undefined);
});

test("other files are unaffected by a hit", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  program(boost, [{ value: readValue(texts) }], texts.join("\n"));
  const other = { ...readValue(texts), path: "D:/w/other.js" };
  boost.postExecute(
    { name: "read", parent: Symbol(), callId: "n9", rootCallId: "c9", arguments: { file_path: "D:/w/other.js" }, agent },
    { isError: false, value: other, content: [] },
  );
  assert.equal(boost.postExecute({ name: "run_code", callId: "c9", rootCallId: "c9", agent }, { isError: false, content: [{ type: "text", text: texts.join(
    "\n") }] }), undefined);
});

test("program output under the cap and without reads is untouched", () => {
  const boost = createBoost({});
  assert.equal(program(boost, [], "hello"), undefined);
});

test("truncation still works on ordinary oversized output", () => {
  const boost = createBoost({});
  const text = Array.from({ length: 800 }, (_, i) => `log line ${i} with a fair amount of text padding`).join("\n");
  const out = textOf(program(boost, [], text));
  assert.ok(out.includes('full text in ref "r1"'));
  const tool = boost.refToolDefinition();
  assert.equal(tool.name, "ref_text");
});

test("failed results are never touched", () => {
  const boost = createBoost({});
  const failed = { isError: true, error: { message: "boom" }, content: [{ type: "text", text: "Error: boom" }] };
  assert.equal(boost.postExecute({ name: "run_code", callId: "c1", rootCallId: "c1", agent }, failed), undefined);
  assert.equal(boost.postExecute({ name: "read", parent: Symbol(), callId: "n1", rootCallId: "c1", agent }, failed), undefined);
});

test("non-text content is left alone", () => {
  const boost = createBoost({});
  assert.equal(boost.postExecute({ name: "run_code", callId: "c1", rootCallId: "c1", agent }, { isError: false, content: [{ type: "image", data: "abc" }] }),
    undefined);
});

test("batching section and switches", () => {
  const boost = createBoost({});
  const section = boost.batchingSection();
  assert.equal(section.name, "ptc-boost:batching");
  assert.ok(section.text.includes("## Using run_code well"));
  assert.ok(section.text.includes("[read-dedup]"));
  assert.equal(createBoost({ batching: { enabled: false } }).batchingSection(), undefined);
  assert.equal(createBoost({ batching: { text: "custom" } }).batchingSection().text, "custom");
});

test("stats line reports both features", () => {
  const boost = createBoost({});
  const texts = fileLines(60);
  const value = readValue(texts);
  program(boost, [{ value }], texts.join("\n"));
  program(boost, [{ value }], texts.join("\n"));
  program(boost, [], "x".repeat(12000));
  const line = boost.statsLine();
  assert.ok(line.includes("read-dedup 1 hit(s)"));
  assert.ok(line.includes("1/3 outputs"));
});

test("helpers", () => {
  assert.equal(textOfContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textOfContent([{ type: "image" }]), undefined);
  assert.equal(sessionIdOf({ agent }), "session-1");
  assert.equal(sessionIdOf({}), undefined);
  const parsed = parseReadValue({ path: "p", offset: 2, lines: [{ number: 2, text: "b" }], totalLines: 3 }, {});
  assert.equal(parsed.endLine, 2);
  assert.equal(parsed.lines[0].text, "b");
  assert.equal(parseReadValue(undefined, {}), undefined);
});

test("config rejects unknown switches and bad values", () => {
  assert.throws(() => createBoost({ dedup: { enable: true } }), /unknown key/);
  assert.throws(() => createBoost({ truncation: { maxChars: 0 } }), /maxChars/);
  assert.throws(() => createBoost({ dedup: { enabled: "yes" } }), /true or false/);
});
