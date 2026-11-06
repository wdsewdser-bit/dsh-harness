/**
 * ptc-boost configuration: three switches, each with its own defaults.
 *
 * The overlay supplies a partial object; anything omitted keeps the shipped
 * default. Unknown keys and invalid values throw at load time so a typo in the
 * overlay is a startup error instead of a silent no-op.
 *
 * @module dsh-ptc-boost/config
 */

/** Output cap (chars) for one program's model-facing result. */
export const DEFAULT_MAX_CHARS = 8000;
/** Share of the cap kept at the head; the rest is the tail. */
export const DEFAULT_HEAD_RATIO = 0.7;
/** Printed read runs shorter than this are never replaced. */
export const DEFAULT_MIN_REPLACE_CHARS = 300;

/** The shipped configuration, by reference for documentation and tests. */
export const DEFAULT_CONFIG = Object.freeze({
  batching: Object.freeze({ enabled: true, text: "" }),
  truncation: Object.freeze({
    enabled: true,
    maxChars: DEFAULT_MAX_CHARS,
    headRatio: DEFAULT_HEAD_RATIO,
    toolName: "ref_text",
    maxEntries: 64,
    maxTotalChars: 4_000_000,
    maxSliceChars: 16384,
  }),
  dedup: Object.freeze({
    enabled: true,
    minReplaceChars: DEFAULT_MIN_REPLACE_CHARS,
    minSeenRatio: 0.5,
    maxChangedRatio: 0.3,
    maxDiffRatio: 0.5,
    maxDiffChars: 4000,
    maxLinesPerFile: 20000,
  }),
});

const TOP_KEYS = new Set(["batching", "truncation", "dedup"]);

function fail(message) {
  throw new TypeError(`ptc-boost config: ${message}`);
}

function record(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function bool(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${label} must be true or false`);
  return value;
}

function int(value, fallback, label, options = {}) {
  const min = options.min ?? 1;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    fail(`${label} must be an integer >= ${min}`);
  }
  return value;
}

function ratio(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0) || !(value < 1)) {
    fail(`${label} must be a number strictly between 0 and 1`);
  }
  return value;
}

function str(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function rejectUnknown(raw, allowed, label) {
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`unknown key "${label}${key}"`);
}

/**
 * Resolve a raw overlay configuration into the effective, validated shape.
 * @param raw - the plugin config from the overlay (`undefined` is allowed).
 * @returns a fresh, fully defaulted configuration object.
 */
export function resolveConfig(raw) {
  const top = record(raw, "config");
  rejectUnknown(top, TOP_KEYS, "");

  const batchingRaw = record(top.batching, "config.batching");
  rejectUnknown(batchingRaw, new Set(["enabled", "text"]), "batching.");
  const truncationRaw = record(top.truncation, "config.truncation");
  rejectUnknown(
    truncationRaw,
    new Set(["enabled", "maxChars", "headRatio", "toolName", "maxEntries", "maxTotalChars", "maxSliceChars"]),
    "truncation.",
  );
  const dedupRaw = record(top.dedup, "config.dedup");
  rejectUnknown(
    dedupRaw,
    new Set(["enabled", "minReplaceChars", "minSeenRatio", "maxChangedRatio", "maxDiffRatio", "maxDiffChars", "maxLinesPerFile"]),
    "dedup.",
  );

  const batching = {
    enabled: bool(batchingRaw.enabled, DEFAULT_CONFIG.batching.enabled, "config.batching.enabled"),
    text: str(batchingRaw.text, DEFAULT_CONFIG.batching.text, "config.batching.text"),
  };
  const truncation = {
    enabled: bool(truncationRaw.enabled, DEFAULT_CONFIG.truncation.enabled, "config.truncation.enabled"),
    maxChars: int(truncationRaw.maxChars, DEFAULT_CONFIG.truncation.maxChars, "config.truncation.maxChars", { min: 2 }),
    headRatio: ratio(truncationRaw.headRatio, DEFAULT_CONFIG.truncation.headRatio, "config.truncation.headRatio"),
    toolName: str(truncationRaw.toolName, DEFAULT_CONFIG.truncation.toolName, "config.truncation.toolName"),
    maxEntries: int(truncationRaw.maxEntries, DEFAULT_CONFIG.truncation.maxEntries, "config.truncation.maxEntries"),
    maxTotalChars: int(truncationRaw.maxTotalChars, DEFAULT_CONFIG.truncation.maxTotalChars, "config.truncation.maxTotalChars"),
    maxSliceChars: int(truncationRaw.maxSliceChars, DEFAULT_CONFIG.truncation.maxSliceChars, "config.truncation.maxSliceChars"),
  };
  if (truncation.toolName.trim().length === 0) fail("config.truncation.toolName must not be empty");

  const dedup = {
    enabled: bool(dedupRaw.enabled, DEFAULT_CONFIG.dedup.enabled, "config.dedup.enabled"),
    minReplaceChars: int(dedupRaw.minReplaceChars, DEFAULT_CONFIG.dedup.minReplaceChars, "config.dedup.minReplaceChars", { min: 0 }),
    minSeenRatio: ratio(dedupRaw.minSeenRatio, DEFAULT_CONFIG.dedup.minSeenRatio, "config.dedup.minSeenRatio"),
    maxChangedRatio: ratio(dedupRaw.maxChangedRatio, DEFAULT_CONFIG.dedup.maxChangedRatio, "config.dedup.maxChangedRatio"),
    maxDiffRatio: ratio(dedupRaw.maxDiffRatio, DEFAULT_CONFIG.dedup.maxDiffRatio, "config.dedup.maxDiffRatio"),
    maxDiffChars: int(dedupRaw.maxDiffChars, DEFAULT_CONFIG.dedup.maxDiffChars, "config.dedup.maxDiffChars", { min: 32 }),
    maxLinesPerFile: int(dedupRaw.maxLinesPerFile, DEFAULT_CONFIG.dedup.maxLinesPerFile, "config.dedup.maxLinesPerFile", { min: 1 }),
  };
  return { batching, truncation, dedup };
}
