/**
 * Pine engine errors (round 74)
 *
 * Error codes follow the official Pine Script error-style: compile errors are
 * prefixed CE (Could not extract / Compile), runtime errors RE. Line/col are
 * 1-based like the official Pine editor. ZERO DOM / host references here - this
 * module is part of the platform-agnostic core.
 *
 * @module core/pine/errors
 */

class PineError extends Error {
  /**
   * @param {string} code  e.g. 'CE10001' / 'RE10139'
   * @param {string} message
   * @param {{line?:number, col?:number, phase?:string}} [where]
   */
  constructor(code, message, where) {
    super(message);
    this.name = 'PineError';
    this.code = code || 'PINE';
    this.line = where && where.line ? where.line : 0;
    this.col = where && where.col ? where.col : 0;
    this.phase = (where && where.phase) || 'runtime';
  }
  /** official-console style one-liner: "CE10001: message (line 12:3)" */
  pretty() {
    const at = this.line ? ` (line ${this.line}${this.col ? ':' + this.col : ''})` : '';
    return `${this.code}: ${this.message}${at}`;
  }
  toJSON() {
    return { code: this.code, message: this.message, line: this.line, col: this.col, phase: this.phase };
  }
}

function lexError(msg, line, col) { return new PineError('CE10006', msg, { line, col, phase: 'lex' }); }
function parseError(msg, line, col) { return new PineError('CE10001', msg, { line, col, phase: 'parse' }); }
function typeError(msg, line, col) { return new PineError('CE10017', msg, { line, col, phase: 'type' }); }
function runtimeError(msg, line, col) { return new PineError('RE10139', msg, { line, col, phase: 'runtime' }); }
function loopError(msg, line, col) { return new PineError('RE10143', msg, { line, col, phase: 'runtime' }); }

export { PineError, lexError, parseError, typeError, runtimeError, loopError };
