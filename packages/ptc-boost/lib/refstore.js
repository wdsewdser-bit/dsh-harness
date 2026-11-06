/**
 * In-memory store for the middles of truncated program outputs.
 *
 * One store per DSH process. Entries are session-tagged so a compaction can
 * drop what the model can no longer see, and both entry count and total chars
 * are capped so an adversarial run cannot grow the process without bound.
 * Nothing is written to disk: refs are a context-recovery aid, not a durable
 * artefact, and a resumed session simply truncates again.
 *
 * @module dsh-ptc-boost/refstore
 */

function assertInt(value, label, min) {
  if (!Number.isInteger(value) || value < min) throw new TypeError(`ptc-boost refstore: ${label} must be an integer >= ${min}`);
}

export class RefStore {
  /**
   * @param options - caps and the id shape. `makeId` is injectable for tests.
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 64;
    this.maxTotalChars = options.maxTotalChars ?? 4_000_000;
    this.maxSliceChars = options.maxSliceChars ?? 16384;
    this.idPrefix = options.idPrefix ?? "r";
    this.makeId = options.makeId ?? ((n) => `${this.idPrefix}${n}`);
    this.entries = new Map();
    this.counter = 0;
    this.chars = 0;
  }

  /**
   * Save one truncated middle.
   * @param text - the omitted middle.
   * @param options - owning session id (used by {@link clear}) and the
   *   absolute offset of `text` inside the original output, so that the offsets
   *   in the truncation marker are the offsets `slice` expects.
   * @returns the ref id to put in the truncation marker.
   */
  put(text, options = {}) {
    if (typeof text !== "string") throw new TypeError("ptc-boost refstore: put expects a string");
    if (text.length === 0) throw new TypeError("ptc-boost refstore: put expects non-empty text");
    const base = options.base ?? 0;
    assertInt(base, "base", 0);
    this.counter += 1;
    const id = this.makeId(this.counter);
    const entry = { id, text, base, session: options.session ?? "", at: options.at ?? Date.now() };
    this.entries.set(id, entry);
    this.chars += text.length;
    this.evict();
    return id;
  }

  /** Whether the id is still stored. */
  has(id) {
    return this.entries.has(id);
  }

  /** Number of live entries. */
  size() {
    return this.entries.size;
  }

  /** Total characters currently retained. */
  totalChars() {
    return this.chars;
  }

  /** The stored entry, or undefined. */
  get(id) {
    return this.entries.get(id);
  }

  /**
   * Return a slice of one saved middle, in the absolute offsets the truncation
   * marker printed.
   * @param id - ref id from the truncation marker.
   * @param options - inclusive `from`, exclusive `to`, as offsets in the
   *   original program output.
   * @returns the slice, the offsets actually served, and where to continue.
   */
  slice(id, options = {}) {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    if (entry === undefined) {
      throw new Error(
        `ptc-boost: unknown ref "${String(id)}" — refs exist only in the DSH process and session that truncated the output; re-run the program and print less.`,
      );
    }
    const base = entry.base;
    const total = base + entry.text.length;
    const requestedFrom = options.from === undefined ? base : options.from;
    assertInt(requestedFrom, "from", 0);
    const from = Math.min(Math.max(requestedFrom, base), total);
    let requestedTo = options.to === undefined ? Math.min(total, from + this.maxSliceChars) : options.to;
    assertInt(requestedTo, "to", 0);
    if (requestedTo < from) throw new RangeError(`ptc-boost: to (${requestedTo}) must be >= from (${from})`);
    let end = Math.min(requestedTo, total);
    if (end - from > this.maxSliceChars) end = from + this.maxSliceChars;
    const more = end < total;
    return {
      id: entry.id,
      from,
      to: end,
      total,
      text: entry.text.slice(from - base, end - base),
      truncated: more,
      nextFrom: more ? end : undefined,
    };
  }

  /** Drop every entry of one session (or all entries when no id is given). */
  clear(session) {
    if (session === undefined) {
      this.entries.clear();
      this.chars = 0;
      return;
    }
    for (const [id, entry] of this.entries) {
      if (entry.session === session) {
        this.chars -= entry.text.length;
        this.entries.delete(id);
      }
    }
  }

  /** Insertion-ordered eviction of the oldest entries past either cap. */
  evict() {
    while (this.entries.size > 0 && (this.entries.size > this.maxEntries || this.chars > this.maxTotalChars)) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      this.chars -= entry.text.length;
      this.entries.delete(oldest.value);
    }
  }
}
