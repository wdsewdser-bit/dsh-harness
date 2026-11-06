import test from "node:test";
import assert from "node:assert/strict";
import { truncateOutput, formatTruncated, countLines } from "../lib/truncate.js";

const lines = (count, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1).padStart(4, "0")} abcdefghijklmnop`).join("\n");

test("output at exactly the cap is untouched", () => {
  const text = "x".repeat(8000);
  const plan = truncateOutput(text, { maxChars: 8000 });
  assert.equal(plan.truncated, false);
  assert.equal(plan.text, text);
  assert.equal(plan.totalChars, 8000);
});

test("one char over the cap truncates", () => {
  const text = "x".repeat(8001);
  const plan = truncateOutput(text, { maxChars: 8000 });
  assert.equal(plan.truncated, true);
  assert.ok(plan.middle.length > 0);
  assert.equal(plan.head.length + plan.middle.length + plan.tail.length, text.length);
  assert.ok(plan.head.length <= 8000);
  assert.ok(plan.tail.length <= 8000);
});

test("head is about 70% and the tail about 30%, cut on line boundaries", () => {
  const text = lines(600);
  const plan = truncateOutput(text, { maxChars: 8000 });
  assert.equal(plan.truncated, true);
  assert.ok(plan.head.length <= 5600 + 1, `head ${plan.head.length}`);
  assert.ok(plan.head.length >= 5600 - 60, `head ${plan.head.length}`);
  assert.ok(plan.tail.length <= 2401, `tail ${plan.tail.length}`);
  assert.ok(plan.tail.length >= 2400 - 60, `tail ${plan.tail.length}`);
  assert.ok(text.startsWith(plan.head));
  assert.ok(text.endsWith(plan.tail));
  assert.equal(plan.headEnd, plan.head.length);
  assert.equal(plan.tailStart, text.length - plan.tail.length);
  assert.equal(plan.middle, text.slice(plan.headEnd, plan.tailStart));
  assert.equal(plan.omittedChars, plan.middle.length);
  // cuts happen at line starts/ends
  assert.notEqual(plan.head.at(-1), undefined);
  assert.ok(plan.tail.startsWith("\n") || text[plan.tailStart - 1] === "\n");
});

test("rendered text keeps head and tail, names the ref and the exact paging call", () => {
  const text = lines(600);
  const plan = truncateOutput(text, { maxChars: 8000 });
  const rendered = formatTruncated(plan, { refId: "r7", toolName: "ref_text" });
  assert.ok(rendered.startsWith(plan.head));
  assert.ok(rendered.includes('full text in ref "r7"'));
  assert.ok(rendered.includes(`await tools.ref_text({ id: "r7", from: ${plan.headEnd}, to: ${plan.tailStart} })`));
  assert.ok(rendered.endsWith(plan.tail + rendered.slice(rendered.lastIndexOf("\nOutput truncated"))));
  assert.ok(rendered.includes(`cap 8000 chars`));
  assert.ok(rendered.includes(`output lines ${plan.fromLine}-${plan.toLine} of ${plan.totalLines}`));
});

test("a single huge line still truncates inside the cap", () => {
  const text = "y".repeat(50000);
  const plan = truncateOutput(text, { maxChars: 8000 });
  assert.equal(plan.truncated, true);
  assert.equal(plan.middle.length, 50000 - 8000);
  assert.equal(plan.totalLines, 1);
  assert.ok(plan.tailStart > plan.headEnd);
});

test("line counting", () => {
  assert.equal(countLines(""), 1);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\n"), 2);
});

test("invalid options are rejected", () => {
  assert.throws(() => truncateOutput("abc", { maxChars: 1 }), RangeError);
  assert.throws(() => truncateOutput("abc", { headRatio: 1 }), RangeError);
  assert.throws(() => formatTruncated({ truncated: false }), TypeError);
  assert.throws(() => formatTruncated({ truncated: true }, {}), TypeError);
});

test("a custom cap moves both the marker and the paging offsets", () => {
  const text = lines(400);
  const plan = truncateOutput(text, { maxChars: 1000 });
  const rendered = formatTruncated(plan, { refId: "r1" });
  assert.ok(rendered.includes("cap 1000 chars"));
  assert.equal(plan.middle, text.slice(plan.headEnd, plan.tailStart));
});
