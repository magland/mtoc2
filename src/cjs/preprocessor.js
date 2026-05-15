'use strict';

// Run the preprocessor on raw C source (comments already stripped).
// Returns a new source string with directives processed and macros expanded.
//
// Supported directives:
//   #include <...>      — ignored
//   #include "..."      — ignored
//   #define NAME value  — object-like macro
//   #define NAME(args) body — function-like macro (basic, no stringify/concat)
//   #undef NAME
//   #ifdef NAME / #ifndef NAME / #else / #endif
//   #if expr / #elif expr / #else / #endif
//   #pragma ...         — ignored
//
// Expression evaluator for #if supports:
//   identifiers (undefined → 0, defined → numeric value or 1)
//   numeric literals (decimal/hex)
//   defined(X), defined X
//   !, &&, ||, +, -, *, /, %, ==, !=, <, <=, >, >=
//   __has_builtin(x) — always 0 (so portable fallback branches are taken)

const PREDEFINED = {
  __GNUC__: '4',
};

function joinContinuations(src) {
  // \<newline> is a continuation in C preprocessing.
  return src.replace(/\\\r?\n/g, '');
}

function preprocess(src) {
  // Continuations were already spliced upstream (c2js.js) so comment-stripping
  // doesn't eat their backslashes. Call here too in case anyone uses
  // preprocess() directly.
  src = joinContinuations(src);
  const lines = src.split('\n');
  const macros = Object.assign({}, PREDEFINED);
  const out = [];

  // Stack of branch states. Each entry: {active, taken, parentActive}
  //   active: are we currently emitting?
  //   taken: has any branch in this if-chain been taken?
  //   parentActive: was the enclosing scope active?
  const stack = [{ active: true, taken: true, parentActive: true, root: true }];

  const isActive = () => stack[stack.length - 1].active;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const trimmed = rawLine.replace(/^\s+/, '');

    if (trimmed.startsWith('#')) {
      // Preserve a blank line so error line numbers stay aligned.
      const directiveLine = trimmed.slice(1).replace(/^\s+/, '');
      const m = directiveLine.match(/^(\w+)\s*(.*)$/);
      const directive = m ? m[1] : '';
      const rest = m ? m[2].trim() : '';

      switch (directive) {
        case 'include':
        case 'pragma':
        case 'line':
        case 'error':
        case 'warning':
          out.push('');
          break;

        case 'define': {
          if (!isActive()) { out.push(''); break; }
          // function-like? "NAME(...)" with no space between name and (
          const fnMatch = rest.match(/^(\w+)\(([^)]*)\)\s*(.*)$/);
          const objMatch = rest.match(/^(\w+)\s*(.*)$/);
          if (fnMatch && fnMatch[2] !== undefined && rest[fnMatch[1].length] === '(') {
            const name = fnMatch[1];
            const params = fnMatch[2].split(',').map(s => s.trim()).filter(Boolean);
            const body = fnMatch[3];
            macros[name] = { fn: true, params, body };
          } else if (objMatch) {
            const name = objMatch[1];
            const body = objMatch[2];
            macros[name] = body;
          }
          out.push('');
          break;
        }

        case 'undef':
          if (isActive()) delete macros[rest];
          out.push('');
          break;

        case 'ifdef': {
          const parentActive = isActive();
          const cond = parentActive && Object.prototype.hasOwnProperty.call(macros, rest);
          stack.push({ active: cond, taken: cond, parentActive });
          out.push('');
          break;
        }
        case 'ifndef': {
          const parentActive = isActive();
          const cond = parentActive && !Object.prototype.hasOwnProperty.call(macros, rest);
          stack.push({ active: cond, taken: cond, parentActive });
          out.push('');
          break;
        }
        case 'if': {
          const parentActive = isActive();
          const cond = parentActive && evalIfExpr(rest, macros);
          stack.push({ active: !!cond, taken: !!cond, parentActive });
          out.push('');
          break;
        }
        case 'elif': {
          const top = stack[stack.length - 1];
          if (top.root) throw new Error(`unexpected #elif`);
          if (top.taken) { top.active = false; }
          else {
            const cond = top.parentActive && evalIfExpr(rest, macros);
            top.active = !!cond;
            if (cond) top.taken = true;
          }
          out.push('');
          break;
        }
        case 'else': {
          const top = stack[stack.length - 1];
          if (top.root) throw new Error(`unexpected #else`);
          if (top.taken) top.active = false;
          else { top.active = top.parentActive; top.taken = true; }
          out.push('');
          break;
        }
        case 'endif':
          if (stack.length <= 1) throw new Error(`unexpected #endif`);
          stack.pop();
          out.push('');
          break;

        default:
          out.push('');
      }
      continue;
    }

    if (isActive()) {
      out.push(rawLine);
    } else {
      out.push('');
    }
  }

  // Macro expansion is a second pass over the entire output so that
  // function-like macro invocations whose arguments span multiple lines
  // (a `,` after the line break, then the rest on the next line) work.
  return expandLine(out.join('\n'), macros);
}

function expandLine(line, macros) {
  // Token-level scan for identifiers; replace if macro. Don't expand inside strings/chars.
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n && line[i] !== q) {
        if (line[i] === '\\' && i + 1 < n) { out += line[i] + line[i + 1]; i += 2; continue; }
        out += line[i]; i++;
      }
      if (i < n) { out += line[i]; i++; }
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      const word = line.substring(i, j);
      if (Object.prototype.hasOwnProperty.call(macros, word)) {
        const m = macros[word];
        if (typeof m === 'string') {
          out += expandLine(m, macros);
          i = j;
          continue;
        }
        if (m && m.fn) {
          // Try to parse arguments
          let k = j;
          while (k < n && /\s/.test(line[k])) k++;
          if (line[k] === '(') {
            const args = [];
            let depth = 1; k++;
            let cur = '';
            while (k < n && depth > 0) {
              const ch = line[k];
              if (ch === '(') { depth++; cur += ch; }
              else if (ch === ')') { depth--; if (depth === 0) { args.push(cur.trim()); cur = ''; } else cur += ch; }
              else if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; }
              else cur += ch;
              k++;
            }
            const paramMap = new Map();
            for (let pi = 0; pi < m.params.length; pi++) {
              paramMap.set(m.params[pi], args[pi] !== undefined ? args[pi] : '');
            }
            let body = m.body;
            // 1. Stringification: `#param` → "arg".  Skip `##` (which is paste).
            body = body.replace(/(?<!#)#(?!#)\s*(\w+)/g, (match, name) => {
              if (paramMap.has(name)) return JSON.stringify(paramMap.get(name));
              return match;
            });
            // 2. Parameter substitution.
            for (const [param, arg] of paramMap) {
              const re = new RegExp('\\b' + escapeRegex(param) + '\\b', 'g');
              body = body.replace(re, arg);
            }
            // 3. Token paste: `a ## b` → `ab`.
            body = body.replace(/\s*##\s*/g, '');
            out += expandLine(body, macros);
            i = k;
            continue;
          }
        }
      }
      out += word;
      i = j;
      continue;
    }
    out += c; i++;
  }
  return out;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ----- #if expression evaluator -----

function evalIfExpr(text, macros) {
  // Pre-process: replace `defined NAME` and `defined(NAME)`, `__has_builtin(...)`, identifiers
  const tokens = tokenizeIfExpr(text);
  const resolved = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'id') {
      if (t.value === 'defined') {
        // defined NAME or defined(NAME)
        let j = i + 1;
        let hasParen = false;
        if (tokens[j] && tokens[j].type === 'punct' && tokens[j].value === '(') { hasParen = true; j++; }
        const name = tokens[j] && tokens[j].type === 'id' ? tokens[j].value : '';
        const isDef = Object.prototype.hasOwnProperty.call(macros, name) ? 1 : 0;
        resolved.push({ type: 'num', value: isDef });
        i = hasParen ? j + 1 : j;
        continue;
      }
      if (t.value === '__has_builtin') {
        // skip optional (arg)
        let j = i + 1;
        if (tokens[j] && tokens[j].type === 'punct' && tokens[j].value === '(') {
          let depth = 1; j++;
          while (j < tokens.length && depth > 0) {
            if (tokens[j].type === 'punct' && tokens[j].value === '(') depth++;
            else if (tokens[j].type === 'punct' && tokens[j].value === ')') depth--;
            j++;
          }
          i = j - 1;
        }
        resolved.push({ type: 'num', value: 0 });
        continue;
      }
      // Resolve macro
      if (Object.prototype.hasOwnProperty.call(macros, t.value)) {
        const m = macros[t.value];
        if (typeof m === 'string') {
          const v = parseInt(m, m.startsWith('0x') ? 16 : 10);
          resolved.push({ type: 'num', value: isNaN(v) ? 0 : v });
        } else {
          resolved.push({ type: 'num', value: 1 });
        }
      } else {
        resolved.push({ type: 'num', value: 0 });
      }
      continue;
    }
    resolved.push(t);
  }
  // Parse and evaluate
  const parser = new IfExprParser(resolved);
  const v = parser.expr();
  return v;
}

function tokenizeIfExpr(text) {
  const tokens = [];
  let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push({ type: 'id', value: text.substring(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(text[j])) j++;
        tokens.push({ type: 'num', value: parseInt(text.substring(i, j), 16) });
      } else {
        while (j < n && /[0-9]/.test(text[j])) j++;
        tokens.push({ type: 'num', value: parseInt(text.substring(i, j), 10) });
      }
      while (j < n && /[uUlL]/.test(text[j])) j++;
      i = j;
      continue;
    }
    const two = text.substring(i, i + 2);
    if (['==','!=','<=','>=','&&','||','<<','>>'].includes(two)) {
      tokens.push({ type: 'op', value: two }); i += 2; continue;
    }
    if ('()'.includes(c)) { tokens.push({ type: 'punct', value: c }); i++; continue; }
    if ('+-*/%!<>&|^~?:,'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    i++;
  }
  return tokens;
}

class IfExprParser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  peek() { return this.tokens[this.i]; }
  eat() { return this.tokens[this.i++]; }
  match(type, value) {
    const t = this.peek();
    if (t && t.type === type && (value === undefined || t.value === value)) { this.i++; return true; }
    return false;
  }
  expr() { return this.logicalOr(); }
  logicalOr() {
    let a = this.logicalAnd();
    while (this.match('op', '||')) {
      const b = this.logicalAnd();
      a = (a || b) ? 1 : 0;
    }
    return a;
  }
  logicalAnd() {
    let a = this.equality();
    while (this.match('op', '&&')) {
      const b = this.equality();
      a = (a && b) ? 1 : 0;
    }
    return a;
  }
  equality() {
    let a = this.relational();
    while (this.peek() && this.peek().type === 'op' && (this.peek().value === '==' || this.peek().value === '!=')) {
      const op = this.eat().value;
      const b = this.relational();
      a = (op === '==' ? a === b : a !== b) ? 1 : 0;
    }
    return a;
  }
  relational() {
    let a = this.additive();
    while (this.peek() && this.peek().type === 'op' && ['<','>','<=','>='].includes(this.peek().value)) {
      const op = this.eat().value;
      const b = this.additive();
      if (op === '<') a = a < b ? 1 : 0;
      else if (op === '>') a = a > b ? 1 : 0;
      else if (op === '<=') a = a <= b ? 1 : 0;
      else a = a >= b ? 1 : 0;
    }
    return a;
  }
  additive() {
    let a = this.multiplicative();
    while (this.peek() && this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.eat().value;
      const b = this.multiplicative();
      a = op === '+' ? a + b : a - b;
    }
    return a;
  }
  multiplicative() {
    let a = this.unary();
    while (this.peek() && this.peek().type === 'op' && ['*','/','%'].includes(this.peek().value)) {
      const op = this.eat().value;
      const b = this.unary();
      if (op === '*') a = a * b;
      else if (op === '/') a = b === 0 ? 0 : Math.trunc(a / b);
      else a = b === 0 ? 0 : a % b;
    }
    return a;
  }
  unary() {
    if (this.match('op', '!')) return this.unary() ? 0 : 1;
    if (this.match('op', '-')) return -this.unary();
    if (this.match('op', '+')) return +this.unary();
    if (this.match('op', '~')) return ~this.unary();
    return this.primary();
  }
  primary() {
    if (this.match('punct', '(')) {
      const v = this.expr();
      this.match('punct', ')');
      return v;
    }
    const t = this.eat();
    if (!t) return 0;
    if (t.type === 'num') return t.value;
    return 0;
  }
}

export { preprocess };
