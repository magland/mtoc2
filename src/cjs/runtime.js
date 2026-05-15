'use strict';

// Emitted at the top of every translated file. Provides a tiny C-stdlib runtime
// (Ptr arithmetic, printf, malloc/free, mem*/str* helpers).
//
// Design notes:
//  * All "pointers" (char*, double*, etc.) are __rt_Ptr objects: {b: buffer, o: offset}.
//  * Arrays declared `T arr[N]` are wrapped as Ptr so they share the same access path
//    as any pointer derived from them (strchr returns Ptr, m_end-- works, etc.).
//  * Struct fields that are arrays (e.g. `long dims[8]`) stay as plain JS arrays —
//    they're never used in pointer arithmetic in the corpus we target.
//  * sizeof(T) for any T is treated as 1 element; sizeof(arr) returns the element
//    count. malloc(n) allocates n element slots, not bytes. This keeps element- vs.
//    byte-arithmetic consistent without needing real byte-level buffers.

const RUNTIME = `
class __rt_Ptr {
  constructor(buffer, offset) { this.b = buffer; this.o = offset | 0; }
  static wrap(buffer, offset) { return new __rt_Ptr(buffer, offset | 0); }
  static add(p, n) {
    n = n | 0;
    if (p == null) return null;
    if (p instanceof __rt_Ptr) return new __rt_Ptr(p.b, p.o + n);
    return new __rt_Ptr(p, n);
  }
  static sub(p, n) {
    n = n | 0;
    if (p == null) return null;
    if (p instanceof __rt_Ptr) return new __rt_Ptr(p.b, p.o - n);
    return new __rt_Ptr(p, -n);
  }
  static diff(a, b) {
    const ao = a instanceof __rt_Ptr ? a.o : 0;
    const bo = b instanceof __rt_Ptr ? b.o : 0;
    return ao - bo;
  }
  static cmp(a, b, op) {
    const ao = a instanceof __rt_Ptr ? a.o : (a == null ? 0 : 0);
    const bo = b instanceof __rt_Ptr ? b.o : (b == null ? 0 : 0);
    switch (op) {
      case '<':  return ao <  bo ? 1 : 0;
      case '<=': return ao <= bo ? 1 : 0;
      case '>':  return ao >  bo ? 1 : 0;
      case '>=': return ao >= bo ? 1 : 0;
      case '==': return (a === b || ao === bo) ? 1 : 0;
      case '!=': return (a !== b && ao !== bo) ? 1 : 0;
    }
    return 0;
  }
  static load(p) {
    if (p == null) return 0;
    if (p instanceof __rt_Ptr) {
      if (typeof p.b === 'string') return p.b.charCodeAt(p.o) | 0;
      return p.b[p.o];
    }
    if (typeof p === 'string') return p.charCodeAt(0) | 0;
    return p[0];
  }
  static store(p, v) {
    if (p instanceof __rt_Ptr) p.b[p.o] = v;
    else p[0] = v;
    return v;
  }
  static at(p, i) {
    if (p == null) return undefined;
    i = i | 0;
    if (p instanceof __rt_Ptr) {
      if (typeof p.b === 'string') return p.b.charCodeAt(p.o + i) | 0;
      return p.b[p.o + i];
    }
    if (typeof p === 'string') return p.charCodeAt(i) | 0;
    return p[i];
  }
  static setAt(p, i, v) {
    i = i | 0;
    if (p instanceof __rt_Ptr) p.b[p.o + i] = v;
    else p[i] = v;
    return v;
  }
  static postUpdate(get, set, op) {
    const cur = get();
    set(__rt_Ptr[op](cur, 1));
    return cur;
  }
  // Read element at index, write back current+delta, return original. Used
  // by codegen for postfix \`p[i]++\` / \`p[i]--\` so the expression remains
  // a single subexpression (no temporary lvalue gymnastics needed).
  static postIndexUpdate(p, i, delta) {
    i = i | 0;
    if (p instanceof __rt_Ptr) {
      const cur = p.b[p.o + i];
      p.b[p.o + i] = cur + delta;
      return cur;
    }
    const cur = p[i];
    p[i] = cur + delta;
    return cur;
  }
}

function __rt_reinterpretPtr(p, kind) { return p; }

function __rt_sizeofArr(p) {
  if (p == null) return 0;
  if (p instanceof __rt_Ptr) return (p.b.length || 0) - p.o;
  return p.length || 0;
}

function __rt_toString(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  let buf, start;
  if (p instanceof __rt_Ptr) { buf = p.b; start = p.o; }
  else { buf = p; start = 0; }
  let s = '';
  for (let i = start; i < buf.length; i++) {
    const c = buf[i] | 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ----- malloc / calloc / free -----

function __rt_malloc(n) {
  n = n | 0;
  if (n <= 0) n = 1;
  return __rt_Ptr.wrap(new Array(n).fill(0), 0);
}
function __rt_calloc(n, size) {
  const total = ((n | 0) * (size | 0));
  return __rt_Ptr.wrap(new Array(total > 0 ? total : 1).fill(0), 0);
}
function __rt_free(_) { /* GC handles it */ }
// C \`realloc(p, n)\`: when \`p\` is null, behaves like malloc; otherwise
// allocates a new buffer of size \`n\` and copies the surviving prefix
// from \`p\`. The C contract permits returning \`NULL\` on failure
// (leaving \`p\` valid), but \`__rt_malloc\` never fails — out-of-memory
// surfaces as a JS allocation throw, mirroring the native binary's
// abort-on-OOM.
function __rt_realloc(p, n) {
  n = n | 0;
  if (p == null) return __rt_malloc(n);
  const dst = __rt_malloc(n);
  const srcBuf = p instanceof __rt_Ptr ? p.b : p;
  const srcOff = p instanceof __rt_Ptr ? p.o : 0;
  const copyLen = Math.min(n > 0 ? n : 0, (srcBuf.length || 0) - srcOff);
  for (let i = 0; i < copyLen; i++) __rt_Ptr.setAt(dst, i, srcBuf[srcOff + i]);
  return dst;
}

// ----- mem*/str* helpers -----

function __rt_memcpy(dst, src, n) {
  n = n | 0;
  for (let i = 0; i < n; i++) __rt_Ptr.setAt(dst, i, __rt_Ptr.at(src, i));
  return dst;
}
// C99 memmove: handles overlap (dst > src) by copying back-to-front so
// the trailing source bytes don't get clobbered before they're read.
// Whether the source and dst point into the same buffer is decided by
// comparing the underlying buffer references — if they don't share a
// buffer, the forward copy is equivalent and faster.
function __rt_memmove(dst, src, n) {
  n = n | 0;
  const sameBuf =
    dst instanceof __rt_Ptr && src instanceof __rt_Ptr && dst.b === src.b;
  if (sameBuf && dst.o > src.o) {
    for (let i = n - 1; i >= 0; i--) __rt_Ptr.setAt(dst, i, __rt_Ptr.at(src, i));
  } else {
    for (let i = 0; i < n; i++) __rt_Ptr.setAt(dst, i, __rt_Ptr.at(src, i));
  }
  return dst;
}
function __rt_memset(dst, v, n) {
  n = n | 0;
  for (let i = 0; i < n; i++) __rt_Ptr.setAt(dst, i, v | 0);
  return dst;
}
function __rt_strlen(p) {
  if (p == null) return 0;
  if (typeof p === 'string') {
    const i = p.indexOf('\\0');
    return i === -1 ? p.length : i;
  }
  const buf = p instanceof __rt_Ptr ? p.b : p;
  const start = p instanceof __rt_Ptr ? p.o : 0;
  for (let i = start; i < buf.length; i++) if ((buf[i] | 0) === 0) return i - start;
  return buf.length - start;
}
function __rt_strchr(p, ch) {
  if (p == null) return null;
  ch = ch | 0;
  // Helper that returns the char code at position i in the buffer, even if
  // the underlying storage is a JS string (where direct indexing would give
  // back a 1-char string, and the prior \`| 0\` cast collapsed everything to 0).
  let buf, start;
  if (p instanceof __rt_Ptr) { buf = p.b; start = p.o; }
  else { buf = p; start = 0; }
  if (typeof buf === 'string') {
    for (let i = start; i < buf.length; i++) {
      const c = buf.charCodeAt(i) | 0;
      if (c === ch) return __rt_Ptr.wrap(buf, i);
      if (c === 0) return null;
    }
    return ch === 0 ? __rt_Ptr.wrap(buf, buf.length) : null;
  }
  for (let i = start; i < buf.length; i++) {
    const c = buf[i] | 0;
    if (c === ch) return __rt_Ptr.wrap(buf, i);
    if (c === 0) return null;
  }
  return null;
}
function __rt_strcmp(a, b) {
  const sa = __rt_toString(a), sb = __rt_toString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function __rt_strcpy(dst, src) {
  const s = __rt_toString(src);
  for (let i = 0; i < s.length; i++) __rt_Ptr.setAt(dst, i, s.charCodeAt(i));
  __rt_Ptr.setAt(dst, s.length, 0);
  return dst;
}
function __rt_atoi(p) {
  const s = __rt_toString(p);
  const m = s.match(/^\\s*[+-]?\\d+/);
  return m ? parseInt(m[0], 10) | 0 : 0;
}
function __rt_atof(p) {
  const s = __rt_toString(p);
  const v = parseFloat(s);
  return Number.isNaN(v) ? 0 : v;
}

// ----- I/O -----

function __rt_write(stream, s) {
  if (stream === 'stderr') process.stderr.write(s);
  else process.stdout.write(s);
}
function __rt_printf(fmt, ...args) {
  const s = __rt_format(fmt, args);
  process.stdout.write(s);
  return s.length;
}
function __rt_fprintf(stream, fmt, ...args) {
  const s = __rt_format(fmt, args);
  __rt_write(stream, s);
  return s.length;
}
function __rt_snprintf(buf, cap, fmt, ...args) {
  const s = __rt_format(fmt, args);
  cap = cap | 0;
  let i = 0;
  const limit = cap > 0 ? Math.min(s.length, cap - 1) : 0;
  for (; i < limit; i++) __rt_Ptr.setAt(buf, i, s.charCodeAt(i));
  if (cap > 0) __rt_Ptr.setAt(buf, i, 0);
  return s.length;
}
function __rt_fputs(str, stream) {
  __rt_write(stream, __rt_toString(str));
  return 0;
}
function __rt_puts(str) {
  process.stdout.write(__rt_toString(str) + '\\n');
  return 0;
}
function __rt_putchar(c) {
  process.stdout.write(String.fromCharCode(c | 0));
  return c | 0;
}
function fputc(c, stream) {
  const ch = String.fromCharCode(c | 0);
  if (stream === 'stderr') process.stderr.write(ch);
  else process.stdout.write(ch);
  return c | 0;
}
function fflush(_stream) { return 0; }
function __rt_fwrite(ptr, size, count, stream) {
  const total = (size | 0) * (count | 0);
  let s = '';
  for (let i = 0; i < total; i++) s += String.fromCharCode(__rt_Ptr.at(ptr, i) | 0);
  __rt_write(stream, s);
  return count;
}

function __rt_abort() {
  process.stderr.write('aborted\\n');
  process.exit(134);
}

// Bridge for C qsort: cmp receives element values (structs or numbers) directly,
// matching how translated user comparators read fields via \`a->field\` -> \`a.field\`.
function qsort(ptr, count, size, cmp) {
  const arr = ptr instanceof __rt_Ptr ? ptr.b : ptr;
  const off = ptr instanceof __rt_Ptr ? ptr.o : 0;
  const slice = arr.slice(off, off + count);
  slice.sort((a, b) => cmp(a, b));
  for (let i = 0; i < count; i++) arr[off + i] = slice[i];
}
function __rt_exit(code) { process.exit((code | 0) || 0); }

// ----- math.h -----
const cos = Math.cos, sin = Math.sin, tan = Math.tan;
const acos = Math.acos, asin = Math.asin, atan = Math.atan, atan2 = Math.atan2;
const cosh = Math.cosh, sinh = Math.sinh, tanh = Math.tanh;
const acosh = Math.acosh, asinh = Math.asinh, atanh = Math.atanh;
const exp = Math.exp, expm1 = Math.expm1;
const log = Math.log, log2 = Math.log2, log10 = Math.log10, log1p = Math.log1p;
const sqrt = Math.sqrt, cbrt = Math.cbrt;
const fabs = Math.abs, floor = Math.floor, ceil = Math.ceil, trunc = Math.trunc;
const pow = Math.pow, hypot = Math.hypot;
function fmod(a, b) { return a - Math.trunc(a / b) * b; }
// C99 \`round\`: half-away-from-zero. JS \`Math.round\` is half-toward-
// +Infinity, so \`Math.round(-2.5) === -2\` but C \`round(-2.5) === -3\`.
// MATLAB \`round\` matches C, so mtoc2's \`mtoc2_round_half_away\`
// runtime body (\`return round(x);\`) needs the C semantics to land on
// the same byte stream as the native binary.
function round(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
// C99 \`fmin\` / \`fmax\`: NaN is treated as missing data — if exactly one
// arg is NaN, the other wins. JS \`Math.min\` / \`Math.max\` propagate
// NaN unconditionally. MATLAB matches the C99 rule, so mtoc2's
// elementwise scalar 2-arg \`min(a, b)\` / \`max(a, b)\` (which lowers to
// \`fmin\`/\`fmax\`) needs the NaN-aware behavior here too.
function fmin(a, b) {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a < b ? a : b;
}
function fmax(a, b) {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a > b ? a : b;
}
function copysign(a, b) { return Math.sign(b) * Math.abs(a); }
function isnan(x) { return Number.isNaN(x); }
function isinf(x) { return x === Infinity || x === -Infinity; }
function isfinite(x) { return Number.isFinite(x); }
const M_PI = Math.PI, M_E = Math.E, M_SQRT2 = Math.SQRT2;
const NAN = NaN, INFINITY = Infinity;
const HUGE_VAL = Infinity;
const LONG_MAX = Number.MAX_SAFE_INTEGER;
const LONG_MIN = -Number.MAX_SAFE_INTEGER;
const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const LLONG_MAX = Number.MAX_SAFE_INTEGER;
const LLONG_MIN = -Number.MAX_SAFE_INTEGER;
const ULONG_MAX = Number.MAX_SAFE_INTEGER;
const SIZE_MAX = Number.MAX_SAFE_INTEGER;
const DBL_MAX = Number.MAX_VALUE;
const DBL_MIN = Number.MIN_VALUE;
const DBL_EPSILON = Number.EPSILON;

// ----- time -----
const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;
function clock_gettime(clk, ts) {
  const [sec, nsec] = process.hrtime();
  ts.tv_sec = sec;
  ts.tv_nsec = nsec;
  return 0;
}

// ----- printf format -----

function __rt_format(fmt, args) {
  if (fmt == null) return '';
  if (typeof fmt !== 'string') fmt = __rt_toString(fmt);
  let out = '';
  let argIdx = 0;
  const n = fmt.length;
  let i = 0;
  while (i < n) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; i++; continue; }
    i++;
    if (i < n && fmt[i] === '%') { out += '%'; i++; continue; }

    let flags = '';
    while (i < n && '-+ 0#'.indexOf(fmt[i]) >= 0) { flags += fmt[i]; i++; }
    let width = '';
    if (fmt[i] === '*') { width = String(args[argIdx++] | 0); i++; }
    else while (i < n && fmt[i] >= '0' && fmt[i] <= '9') { width += fmt[i]; i++; }
    let precision = null;
    if (fmt[i] === '.') {
      i++;
      precision = '';
      if (fmt[i] === '*') { precision = String(args[argIdx++] | 0); i++; }
      else while (i < n && fmt[i] >= '0' && fmt[i] <= '9') { precision += fmt[i]; i++; }
    }
    while (i < n && 'hljztL'.indexOf(fmt[i]) >= 0) i++;
    const conv = fmt[i]; i++;
    const arg = args[argIdx++];
    out += __rt_formatArg(conv, arg, flags, width, precision);
  }
  return out;
}

function __rt_formatArg(conv, arg, flags, width, precision) {
  let s;
  const w = width ? parseInt(width, 10) : 0;
  switch (conv) {
    case 'd': case 'i': {
      let v = arg | 0;
      const neg = v < 0;
      s = String(Math.abs(v));
      if (precision !== null) {
        const p = parseInt(precision, 10);
        if (s.length < p) s = '0'.repeat(p - s.length) + s;
      }
      s = (neg ? '-' : (flags.includes('+') ? '+' : (flags.includes(' ') ? ' ' : ''))) + s;
      break;
    }
    case 'u': {
      let v = arg | 0;
      if (v < 0) v = v + 0x100000000;
      s = String(v);
      break;
    }
    case 'x': s = ((arg | 0) >>> 0).toString(16); break;
    case 'X': s = ((arg | 0) >>> 0).toString(16).toUpperCase(); break;
    case 'o': s = ((arg | 0) >>> 0).toString(8); break;
    case 'f': case 'F': {
      const p = precision !== null ? parseInt(precision, 10) : 6;
      s = Number(arg).toFixed(p);
      break;
    }
    case 'e': case 'E': {
      const p = precision !== null ? parseInt(precision, 10) : 6;
      s = Number(arg).toExponential(p);
      s = s.replace(/e([+-])(\\d)$/, 'e$10$2');
      if (conv === 'E') s = s.toUpperCase();
      break;
    }
    case 'g': case 'G': {
      const p = precision !== null ? parseInt(precision, 10) : 6;
      const eform = Number(arg).toExponential(p - 1);
      const expPart = parseInt(eform.split('e')[1], 10);
      if (expPart < -4 || expPart >= p) s = eform;
      else s = Number(arg).toPrecision(p);
      if (!flags.includes('#')) {
        // strip trailing zeros
        if (s.includes('.') && !s.includes('e')) s = s.replace(/0+$/, '').replace(/\\.$/, '');
      }
      if (conv === 'G') s = s.toUpperCase();
      break;
    }
    case 'c': s = typeof arg === 'string' ? arg : String.fromCharCode(arg | 0); break;
    case 's': {
      if (arg == null) s = '(null)';
      else if (typeof arg === 'string') s = arg;
      else s = __rt_toString(arg);
      if (precision !== null) {
        const p = parseInt(precision, 10);
        if (s.length > p) s = s.substring(0, p);
      }
      break;
    }
    case 'p': s = arg == null ? '(nil)' : '0x' + (arg.o ? arg.o.toString(16) : '0'); break;
    case 'n': return '';
    default: return '%' + conv;
  }
  if (w && s.length < w) {
    if (flags.includes('-')) s = s.padEnd(w);
    else if (flags.includes('0') && /^[-+ ]?\\d/.test(s) && (conv === 'd' || conv === 'i' || conv === 'u'
            || conv === 'f' || conv === 'F' || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G'
            || conv === 'x' || conv === 'X' || conv === 'o')) {
      const sign = (s[0] === '-' || s[0] === '+' || s[0] === ' ') ? s[0] : '';
      const body = sign ? s.slice(1) : s;
      s = sign + body.padStart(w - sign.length, '0');
    }
    else s = s.padStart(w);
  }
  return s;
}

// ----- scalar complex helpers ---------------------------------------
//
// mtoc2's C emit routes every \`double _Complex\` operation in user
// code through one of the \`mtoc2_c*\` helpers in \`runtime/cscalar.h\`
// (plus \`mtoc2_cdiv\`, \`mtoc2_format_complex\`, \`mtoc2_disp_complex\`).
// On the native target those are \`static inline\` wrappers around C99
// operators; on this JS target they operate on a \`{re, im}\` plain-
// object representation. The c2js codegen skip-list (see
// COMPLEX_SKIP_FUNCS in codegen.js) prevents c2js from re-emitting
// the C definitions, so these JS versions are the authoritative
// implementations.
//
// Helpers accept either a \`{re, im}\` object or a JS number — the
// latter is treated as a pure-real complex. This matches mtoc2's
// emit shape where real-typed operands get passed in alongside
// complex-typed ones (\`mtoc2_cadd(1.0, mtoc2_cmake(0, 2))\`) and
// where \`double _Complex\` locals are predeclared as \`= 0.0\` (a
// number) before being assigned a real complex value.

function __rt_cre(x) { return typeof x === 'number' ? x : x.re; }
function __rt_cim(x) { return typeof x === 'number' ? 0 : x.im; }
function mtoc2_cmake(re, im) { return { re: +re, im: +im }; }
function mtoc2_creal(z) { return __rt_cre(z); }
function mtoc2_cimag(z) { return __rt_cim(z); }
function mtoc2_cadd(a, b) {
  return { re: __rt_cre(a) + __rt_cre(b), im: __rt_cim(a) + __rt_cim(b) };
}
function mtoc2_csub(a, b) {
  return { re: __rt_cre(a) - __rt_cre(b), im: __rt_cim(a) - __rt_cim(b) };
}
function mtoc2_cmul(a, b) {
  const ar = __rt_cre(a), ai = __rt_cim(a), br = __rt_cre(b), bi = __rt_cim(b);
  return { re: ar * br - ai * bi, im: ar * bi + ai * br };
}
function mtoc2_cneg(z) { return { re: -__rt_cre(z), im: -__rt_cim(z) }; }
function mtoc2_cconj(z) { return { re: __rt_cre(z), im: -__rt_cim(z) }; }
function mtoc2_cabs(z) { return Math.hypot(__rt_cre(z), __rt_cim(z)); }
function mtoc2_cangle(z) { return Math.atan2(__rt_cim(z), __rt_cre(z)); }
function mtoc2_cnonzero(z) {
  return (__rt_cre(z) !== 0 || __rt_cim(z) !== 0) ? 1 : 0;
}
function mtoc2_ceq(a, b) {
  return (__rt_cre(a) === __rt_cre(b) && __rt_cim(a) === __rt_cim(b)) ? 1 : 0;
}
function mtoc2_cne(a, b) {
  return (__rt_cre(a) !== __rt_cre(b) || __rt_cim(a) !== __rt_cim(b)) ? 1 : 0;
}

// Smith's algorithm for complex division — mirrors \`cdiv.h\`'s C
// implementation so cross-runner output stays byte-identical.
function mtoc2_cdiv(a, b) {
  const ar = __rt_cre(a), ai = __rt_cim(a);
  const br = __rt_cre(b), bi = __rt_cim(b);
  if (Math.abs(br) >= Math.abs(bi)) {
    const r = bi / br;
    const den = br + r * bi;
    return { re: (ar + ai * r) / den, im: (ai - ar * r) / den };
  }
  const r = br / bi;
  const den = bi + r * br;
  return { re: (ar * r + ai) / den, im: (ai * r - ar) / den };
}

// cpow via the exp/log identity. The native side defers to libm's
// \`cpow\`; this JS path computes \`exp(b * log(a))\` directly. Real-only
// operands could fall back to \`Math.pow\`, but the few sites that call
// this go through the complex path because at least one operand is
// complex-typed.
function mtoc2_cpow(a, b) {
  const ar = __rt_cre(a), ai = __rt_cim(a);
  const br = __rt_cre(b), bi = __rt_cim(b);
  if (ar === 0 && ai === 0) {
    return (br === 0 && bi === 0) ? { re: 1, im: 0 } : { re: 0, im: 0 };
  }
  const logMag = 0.5 * Math.log(ar * ar + ai * ai);
  const logArg = Math.atan2(ai, ar);
  const er = br * logMag - bi * logArg;
  const ei = br * logArg + bi * logMag;
  const m = Math.exp(er);
  return { re: m * Math.cos(ei), im: m * Math.sin(ei) };
}

// disp/format helpers for scalar complex. \`mtoc2_format_complex\`
// mirrors numbl's \`formatComplex\` and \`disp_complex.h\` so cross-
// runner stdout aligns byte-for-byte with the native run.
function mtoc2_format_complex(out, cap, z) {
  const re = __rt_cre(z), im = __rt_cim(z);
  // \`formatNumber\`-style render for each component.
  const buf = __rt_Ptr.wrap(new Uint8Array(64));
  mtoc2_format_double(buf, 64, re);
  const reStr = __rt_toString(buf);
  mtoc2_format_double(buf, 64, Math.abs(im));
  const imAbsStr = __rt_toString(buf);
  let s;
  if (im === 0) {
    s = reStr;
  } else if (re === 0) {
    s = (im < 0 ? '-' : '') + imAbsStr + 'i';
  } else {
    s = reStr + (im < 0 ? ' - ' : ' + ') + imAbsStr + 'i';
  }
  return __rt_snprintf(out, cap, '%s', s);
}
function mtoc2_disp_complex(z) {
  const buf = __rt_Ptr.wrap(new Uint8Array(128));
  mtoc2_format_complex(buf, 128, z);
  __rt_printf('%s\\n', buf);
}

// Complex multi-element tensor disp. Mirrors the C
// \`mtoc2_disp_tensor_complex\` (which loops slices, formats each cell
// via \`mtoc2_format_complex\`, pads columns to the widest cell). The
// C body holds a bare \`double _Complex\` local per cell which c2js
// can't translate, so this JS impl is the substitute.
function mtoc2__disp_complex_slice(re, im, rows, cols) {
  const ncells = rows * cols;
  const cells = new Array(ncells);
  const colWidths = new Int32Array(cols);
  const buf = __rt_Ptr.wrap(new Uint8Array(80));
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const idx = r + c * rows;
      const z = { re: __rt_Ptr.at(re, idx), im: __rt_Ptr.at(im, idx) };
      mtoc2_format_complex(buf, 80, z);
      const s = __rt_toString(buf);
      cells[idx] = s;
      if (s.length > colWidths[c]) colWidths[c] = s.length;
    }
  }
  for (let r = 0; r < rows; r++) {
    let line = '   ';
    for (let c = 0; c < cols; c++) {
      const idx = r + c * rows;
      const s = cells[idx];
      const pad = colWidths[c] - s.length;
      line += ' '.repeat(pad > 0 ? pad : 0) + s;
      if (c < cols - 1) line += '   ';
    }
    __rt_printf('%s\\n', line);
  }
}
function mtoc2_disp_tensor_complex(t) {
  if (t.ndim === 0 || t.real === null) return;
  const rows = t.ndim >= 1 ? __rt_Ptr.at(t.dims, 0) : 1;
  const cols = t.ndim >= 2 ? __rt_Ptr.at(t.dims, 1) : 1;
  let total = 1;
  for (let i = 0; i < t.ndim; i++) total *= __rt_Ptr.at(t.dims, i);
  if (total <= 0) return;
  const pageSize = rows * cols;
  let numPages = 1;
  for (let i = 2; i < t.ndim; i++) numPages *= __rt_Ptr.at(t.dims, i);
  for (let p = 0; p < numPages; p++) {
    if (t.ndim > 2) {
      if (p > 0) __rt_printf('\\n');
      let rem = p;
      let header = '(:,:';
      for (let i = 2; i < t.ndim; i++) {
        const d = __rt_Ptr.at(t.dims, i);
        const s = rem % d;
        rem = Math.trunc(rem / d);
        header += ',' + (s + 1);
      }
      header += ') =\\n\\n';
      __rt_printf('%s', header);
    }
    const reSlice = __rt_Ptr.add(t.real, p * pageSize);
    const imSlice = __rt_Ptr.add(t.imag, p * pageSize);
    mtoc2__disp_complex_slice(reSlice, imSlice, rows, cols);
  }
}
`;

export { RUNTIME };
