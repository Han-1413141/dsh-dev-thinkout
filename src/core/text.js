/**
 * Small, dependency-free text helpers shared by the core modules.
 * No function here writes to a log or performs I/O.
 */

/** @param {number} value @returns {boolean} */
export function isHighSurrogate(value) {
  return value >= 0xd800 && value <= 0xdbff;
}

/** @param {number} value @returns {boolean} */
export function isLowSurrogate(value) {
  return value >= 0xdc00 && value <= 0xdfff;
}

/**
 * Truncate at Unicode code-point boundaries so a surrogate pair is never split.
 * @param {unknown} value
 * @param {number} max
 * @param {string} [suffix]
 * @returns {string}
 */
export function truncateText(value, max, suffix = '…') {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!Number.isSafeInteger(max) || max <= 0) return '';
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  const room = Math.max(0, max - suffix.length);
  return points.slice(0, room).join('') + suffix;
}

/**
 * Collapse line breaks and repeated whitespace for a one-line label.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(value, max = 240) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return truncateText(normalized, max);
}

/**
 * Normalize an identity key without changing meaning beyond case/whitespace.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function normalizeKey(value, max = 240) {
  return oneLine(value, max).toLowerCase();
}

/**
 * Stable 32-bit FNV-1a hash rendered as hex. It is an identity device, not a
 * security primitive.
 * @param {string} text
 * @returns {string}
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a deterministic short id from textual parts.
 * @param {string} prefix
 * @param {...string} parts
 * @returns {string}
 */
export function stableId(prefix, ...parts) {
  return `${prefix}_${fnv1a(parts.map((part) => String(part)).join('\u001f'))}`;
}

/**
 * Copy a plain object while dropping undefined values.
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
export function defined(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
