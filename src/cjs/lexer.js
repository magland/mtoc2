'use strict';

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
  'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
  'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while', '_Bool', '_Complex',
  '__restrict__', '__restrict',
]);

const MULTI_CHAR_OPS = [
  '<<=', '>>=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '++', '--', '->', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=',
];

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { out += ' '; i = n; break; }
      // preserve newlines so line numbers stay aligned
      for (let j = i; j < end + 2; j++) {
        out += src[j] === '\n' ? '\n' : ' ';
      }
      i = end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += c; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i]; out += src[i + 1]; i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Read one C escape sequence starting at src[i] (which must be a backslash).
// Calls emit(charCode) with the resulting code point and returns the number
// of source characters consumed (including the leading backslash).
//
// Handled: standard one-char escapes (\n \t \r \0 \\ \" \' \a \b \f \v \?),
// hex escapes (\xHH...), and octal escapes (\NNN, up to 3 digits).
function readEscape(src, i, emit) {
  const e = src[i + 1];
  if (e === 'n') { emit(10); return 2; }
  if (e === 't') { emit(9);  return 2; }
  if (e === 'r') { emit(13); return 2; }
  if (e === 'b') { emit(8);  return 2; }
  if (e === 'f') { emit(12); return 2; }
  if (e === 'v') { emit(11); return 2; }
  if (e === 'a') { emit(7);  return 2; }
  if (e === '0' && !(src[i + 2] >= '0' && src[i + 2] <= '7')) { emit(0); return 2; }
  if (e === '\\') { emit(92); return 2; }
  if (e === '"')  { emit(34); return 2; }
  if (e === "'")  { emit(39); return 2; }
  if (e === '?')  { emit(63); return 2; }
  if (e === 'x') {
    // \xHH...  consume up to 8 hex digits (clamped to char range)
    let j = i + 2;
    let val = 0;
    while (j < src.length && /[0-9A-Fa-f]/.test(src[j])) {
      val = val * 16 + parseInt(src[j], 16);
      j++;
    }
    emit(val & 0xff);
    return j - i;
  }
  if (e >= '0' && e <= '7') {
    // octal: up to 3 octal digits
    let j = i + 1, val = 0, count = 0;
    while (count < 3 && j < src.length && src[j] >= '0' && src[j] <= '7') {
      val = val * 8 + (src.charCodeAt(j) - 48);
      j++; count++;
    }
    emit(val & 0xff);
    return j - i;
  }
  // Unknown escape — pass through the character literally.
  emit(e.charCodeAt(0));
  return 2;
}

function isIdStart(c) { return /[A-Za-z_]/.test(c); }
function isIdCont(c) { return /[A-Za-z0-9_]/.test(c); }
function isDigit(c) { return c >= '0' && c <= '9'; }

function tokenize(src, filename = '<input>') {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  function col() { return i - lineStart + 1; }
  function push(type, value, extra = {}) {
    tokens.push({ type, value, line, col: col(), ...extra });
  }

  while (i < n) {
    const c = src[i];

    if (c === '\n') { line++; i++; lineStart = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdCont(src[i])) i++;
      const word = src.substring(start, i);
      if (KEYWORDS.has(word)) push('kw', word);
      else push('id', word);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      const start = i;
      let isFloat = false;
      let isHex = false;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        isHex = true; i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(src[i])) i++;
      } else {
        while (i < n && isDigit(src[i])) i++;
        if (src[i] === '.') { isFloat = true; i++; while (i < n && isDigit(src[i])) i++; }
        if (src[i] === 'e' || src[i] === 'E') {
          isFloat = true; i++;
          if (src[i] === '+' || src[i] === '-') i++;
          while (i < n && isDigit(src[i])) i++;
        }
      }
      // suffixes: u/U/l/L/f/F
      while (i < n && /[uUlLfF]/.test(src[i])) {
        if (src[i] === 'f' || src[i] === 'F') isFloat = true;
        i++;
      }
      const text = src.substring(start, i);
      let val;
      if (isHex) val = parseInt(text.replace(/[uUlL]+$/, ''), 16);
      else if (isFloat) val = parseFloat(text.replace(/[uUlLfF]+$/, ''));
      else val = parseInt(text.replace(/[uUlL]+$/, ''), 10);
      push('num', val, { isFloat, text });
      continue;
    }

    if (c === '"') {
      i++;
      let s = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const consumed = readEscape(src, i, (code) => s += String.fromCharCode(code));
          i += consumed;
          continue;
        }
        s += src[i]; i++;
      }
      if (i < n) i++;
      push('str', s);
      continue;
    }

    if (c === "'") {
      i++;
      let code;
      if (src[i] === '\\' && i + 1 < n) {
        const consumed = readEscape(src, i, (ch) => { code = ch; });
        i += consumed;
      } else {
        code = src.charCodeAt(i); i++;
      }
      if (src[i] === "'") i++;
      push('chr', code);
      continue;
    }

    // multi-char operators
    let matched = false;
    for (const op of MULTI_CHAR_OPS) {
      if (src.startsWith(op, i)) {
        push('op', op);
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if ('()[]{},;?:'.includes(c)) {
      push('punct', c); i++; continue;
    }
    if ('+-*/%<>=!&|^~.'.includes(c)) {
      push('op', c); i++; continue;
    }
    if (c === '#') {
      // preprocessor directives should have been removed by the preprocessor.
      // If still present, treat as error.
      throw new Error(`${filename}:${line}: unexpected '#' at column ${col()}`);
    }

    throw new Error(`${filename}:${line}:${col()}: unexpected character '${c}'`);
  }

  push('eof', null);
  return tokens;
}

export { tokenize, stripComments, KEYWORDS };
