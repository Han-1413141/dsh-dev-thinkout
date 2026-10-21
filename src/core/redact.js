/**
 * Remove credential-shaped material before text leaves the process or is
 * rendered. This is deliberately conservative: it may redact a harmless
 * assignment, but it must not echo a secret.
 */

const REDACTED = '[REDACTED]';
const REDACTED_KEY = '[REDACTED PRIVATE KEY]';
const SENSITIVE_KEY = /(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|credentials?|private[_-]?key|client[_-]?secret)/i;

const STRING_RULES = [
  // PEM private keys, including OpenSSH.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    () => REDACTED_KEY],
  // Authorization and proxy-authorization header values.
  [/\b((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic|token|digest)\s+[^\s,;]+/gi,
    (_match, prefix) => `${prefix}${REDACTED}`],
  // Cookie headers can carry session material.
  [/\b((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
    (_match, prefix) => `${prefix}${REDACTED}`],
  // Credentials embedded in an HTTP(S) URL.
  [/(\bhttps?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
    (_match, prefix) => `${prefix}${REDACTED}@`],
  // Common provider token prefixes.
  [/\bsk-vsr-[A-Za-z0-9_-]{8,}\b/g, () => REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, () => REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, () => REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, () => REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}\b/g, () => REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, () => REDACTED],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, () => REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, () => REDACTED],
  // A bare Bearer token that was not part of a recognized header.
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, prefix) => `${prefix} ${REDACTED}`],
  // JSON-style header keys such as {"X-API-Key":"..."} or {"authorization":"Bearer ..."}.
  [/(["'])((?:x-api-key|api-key|authorization|proxy-authorization))(?![A-Za-z])\1(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
    (_match, quote, key, separator) => `${quote}${key}${quote}${separator}"${REDACTED}"`],
  // JSON-style sensitive keys: {"apiKey":"..."} or {'token': '...'}.
  [/(["'])([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd|credentials?|private[_-]?key|client[_-]?secret))(?![A-Za-z])\1(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
    (_match, quote, key, separator) => `${quote}${key}${quote}${separator}"${REDACTED}"`],
  // Environment or assignment style: DEEPSEEK_API_KEY=..., token: ...
  [/\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"',;&]+))/gi,
    (_match, key, separator, doubleQuoted, singleQuoted) => {
      if (doubleQuoted !== undefined) return `${key}${separator}"${REDACTED}"`;
      if (singleQuoted !== undefined) return `${key}${separator}'${REDACTED}'`;
      return `${key}${separator}${REDACTED}`;
    }],
  // CLI flags: --api-key secret, --token=secret.
  [/(--?(?:api[-_]?key|access[-_]?key|token|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
    (_match, prefix) => `${prefix}${REDACTED}`],
];

/**
 * @param {string} text
 * @returns {string}
 */
export function redactString(text) {
  let output = text;
  for (const [pattern, replacement] of STRING_RULES) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Redact a string, or a plain JSON-like value. Object keys are retained so
 * consumers keep their structure; only values are rewritten.
 *
 * @param {unknown} value
 * @param {{maxDepth?: number}} [options]
 * @returns {unknown}
 */
export function redact(value, options = {}) {
  const maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth
    : 8;
  const seen = new WeakSet();

  function walk(current, depth) {
    if (typeof current === 'string') return redactString(current);
    if (current === null || typeof current !== 'object') return current;
    if (depth >= maxDepth) return '[Omitted: depth limit]';
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    if (Array.isArray(current)) return current.map((entry) => walk(entry, depth + 1));
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return '[Omitted: unsupported object]';
    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => {
        if (SENSITIVE_KEY.test(key)) {
          return [key, REDACTED];
        }
        return [key, walk(entry, depth + 1)];
      }),
    );
  }

  return walk(value, 0);
}

export { REDACTED };
