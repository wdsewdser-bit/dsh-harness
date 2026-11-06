import test from "node:test";
import assert from "node:assert/strict";
import { RefStore } from "../lib/refstore.js";

const text = Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\n");

test("put stores the text and slice returns the requested range", () => {
  const store = new RefStore();
  const id = store.put(text);
  const whole = store.slice(id, {});
  assert.equal(whole.text, text);
  assert.equal(whole.total, text.length);
  const part = store.slice(id, { from: 10, to: 20 });
  assert.equal(part.text, text.slice(10, 20));
  assert.equal(part.truncated, true, "content remains after to=20");
  assert.equal(part.nextFrom, 20);
});

test("a base offset makes the marker's absolute offsets addressable", () => {
  const store = new RefStore();
  const id = store.put("0123456789", { base: 500 });
  const slice = store.slice(id, { from: 503, to: 507 });
  assert.equal(slice.text, "3456");
  assert.equal(slice.total, 510);
  assert.equal(slice.from, 503);
  assert.equal(slice.to, 507);
  assert.equal(slice.truncated, true);
  assert.equal(slice.nextFrom, 507);
  assert.equal(store.slice(id).from, 500);
});

test("slice caps one response and reports where to continue", () => {
  const store = new RefStore({ maxSliceChars: 16 });
  const id = store.put(text);
  const first = store.slice(id, { from: 0, to: 100 });
  assert.equal(first.text.length, 16);
  assert.equal(first.truncated, true);
  assert.equal(first.nextFrom, 16);
  const second = store.slice(id, { from: first.nextFrom });
  assert.equal(second.from, 16);
  assert.equal(second.text, text.slice(16, 32));
});

test("slice clamps past the end", () => {
  const store = new RefStore();
  const id = store.put(text);
  const tail = store.slice(id, { from: text.length + 50 });
  assert.equal(tail.text, "");
  assert.equal(tail.from, text.length);
  assert.equal(tail.truncated, false);
});

test("unknown ref and bad ranges throw", () => {
  const store = new RefStore();
  assert.throws(() => store.slice("nope", {}), /unknown ref/);
  const id = store.put(text);
  assert.throws(() => store.slice(id, { from: 10, to: 5 }), RangeError);
  assert.throws(() => store.slice(id, { from: -1 }), TypeError);
  assert.throws(() => store.put(""), TypeError);
});

test("eviction keeps the newest entries inside both caps", () => {
  const byCount = new RefStore({ maxEntries: 2 });
  const a = byCount.put("aaaa");
  const b = byCount.put("bbbb");
  const c = byCount.put("cccc");
  assert.equal(byCount.size(), 2);
  assert.equal(byCount.has(a), false);
  assert.equal(byCount.has(b), true);
  assert.equal(byCount.has(c), true);

  const byChars = new RefStore({ maxEntries: 10, maxTotalChars: 10 });
  const x = byChars.put("123456");
  const y = byChars.put("123456");
  assert.equal(byChars.has(x), false);
  assert.equal(byChars.has(y), true);
  assert.equal(byChars.totalChars(), 6);
});

test("clear drops one session only", () => {
  const store = new RefStore();
  const a = store.put("aaaa", { session: "s1" });
  const b = store.put("bbbb", { session: "s2" });
  store.clear("s1");
  assert.equal(store.has(a), false);
  assert.equal(store.has(b), true);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.totalChars(), 0);
});
