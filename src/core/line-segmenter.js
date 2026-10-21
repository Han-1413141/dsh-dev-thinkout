import { isHighSurrogate, isLowSurrogate } from './text.js';

/**
 * @typedef {object} LineSegment
 * @property {string} text Line content without its line break.
 * @property {boolean} complete True when a newline or flush ended this logical line.
 * @property {boolean} overflow True when the segment was cut by maxLineLength.
 * @property {'\n'|'\r\n'|null} newline Original break, when one ended the line.
 */

/**
 * Incremental line splitter for streamed reasoning text.
 *
 * Newlines are boundaries; CRLF is recognized across chunks. A logical line
 * longer than `maxLineLength` is emitted as several non-complete segments so
 * the caller can bound work without dropping characters. Concatenate `text`
 * in order, appending one logical line at a time and emitting it when
 * `complete` is true; every character is emitted exactly once.
 */
export class LineSegmenter {
  /**
   * @param {{maxLineLength?: number}} [options]
   */
  constructor(options = {}) {
    const requested = options.maxLineLength ?? options.maxLineChars ?? 4096;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new RangeError('maxLineLength must be a positive safe integer');
    }
    this.maxLineLength = requested;
    this.buffer = '';
  }

  /** Number of buffered UTF-16 code units. */
  get pending() {
    return this.buffer.length;
  }

  /**
   * Append one stream chunk.
   * @param {string} chunk
   * @returns {LineSegment[]}
   */
  push(chunk) {
    if (typeof chunk !== 'string') {
      throw new TypeError('LineSegmenter.push expects a string');
    }
    if (chunk.length === 0) return [];

    const output = [];
    let start = 0;
    while (start < chunk.length) {
      const newlineAt = chunk.indexOf('\n', start);
      if (newlineAt === -1) {
        this.buffer += chunk.slice(start);
        this.#drain(output, false);
        break;
      }

      this.buffer += chunk.slice(start, newlineAt);
      let newline = '\n';
      if (this.buffer.endsWith('\r')) {
        this.buffer = this.buffer.slice(0, -1);
        newline = '\r\n';
      }
      this.#drain(output, true);
      output.push({
        text: this.buffer,
        complete: true,
        overflow: false,
        newline,
      });
      this.buffer = '';
      start = newlineAt + 1;
    }
    return output;
  }

  /**
   * Finish the stream. Any buffered partial line becomes one complete segment.
   * Calling flush again returns an empty array.
   * @returns {LineSegment[]}
   */
  flush() {
    const output = [];
    this.#drain(output, true);
    if (this.buffer.length > 0) {
      output.push({
        text: this.buffer,
        complete: true,
        overflow: false,
        newline: null,
      });
      this.buffer = '';
    }
    return output;
  }

  /** Drop all buffered content and reusable after a flush. */
  reset() {
    this.buffer = '';
  }

  /**
   * Emit overlong prefixes. It never cuts between the two code units of a
   * surrogate pair, and (outside flush) it never emits a trailing CR that the
   * next chunk could pair with LF.
   * @param {LineSegment[]} output
   * @param {boolean} final
   */
  #drain(output, final) {
    // A trailing CR may be the first half of a CRLF in the next chunk. Hold
    // only that code unit while still draining any overlong content before it.
    let pendingCR = '';
    if (!final && this.buffer.endsWith('\r')) {
      pendingCR = '\r';
      this.buffer = this.buffer.slice(0, -1);
    }
    while (this.buffer.length > this.maxLineLength) {
      let cut = this.maxLineLength;
      if (cut > 0 && isHighSurrogate(this.buffer.charCodeAt(cut - 1))) {
        if (cut < this.buffer.length && isLowSurrogate(this.buffer.charCodeAt(cut))) {
          cut += 1;
        } else {
          cut -= 1;
        }
      }
      if (cut <= 0) {
        if (this.buffer.length > 1 && isLowSurrogate(this.buffer.charCodeAt(1))) {
          cut = 2;
        } else {
          cut = 1;
        }
      }

      output.push({
        text: this.buffer.slice(0, cut),
        complete: false,
        overflow: true,
        newline: null,
      });
      this.buffer = this.buffer.slice(cut);
    }
    this.buffer += pendingCR;
  }
}
