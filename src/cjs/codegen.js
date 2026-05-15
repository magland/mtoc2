'use strict';

// Walk the AST and emit JavaScript.

const JS_RESERVED = new Set([
  'await','break','case','catch','class','const','continue','debugger','default',
  'delete','do','else','enum','export','extends','false','finally','for','function',
  'if','implements','import','in','instanceof','interface','let','new','null',
  'package','private','protected','public','return','static','super','switch',
  'this','throw','true','try','typeof','var','void','while','with','yield',
  'arguments','eval',
]);
function safeId(name) { return JS_RESERVED.has(name) ? ('_' + name) : name; }

function generate(ast, opts = {}) {
  const ctx = makeContext();
  registerTypes(ast, ctx);

  let out = '';
  for (const d of ast.decls) {
    out += genTopLevel(d, ctx) + '\n';
  }
  // Always call main() at the end, if defined.
  if (ctx.functions.has('main')) {
    out += `\nconst __rt_rc = main();\nif (typeof __rt_rc === 'number' && __rt_rc !== 0) process.exit(__rt_rc);\n`;
  }
  return out;
}

// ============================================================
// Context & type helpers
// ============================================================

function makeContext() {
  return {
    typedefs: new Map(),       // typedef name → underlying type
    structs: new Map(),        // struct tag → fields
    structClones: new Map(),   // typedef-struct name → generated clone fn name
    functions: new Map(),      // name → {returnType, paramTypes}
    indent: 0,
  };
}

function registerTypes(ast, ctx) {
  for (const d of ast.decls) {
    if (d.kind === 'TypedefDecl') {
      for (const def of d.defs) {
        ctx.typedefs.set(def.name, def.type);
        // Also remember struct typedefs by their typedef name.
        const fields = getStructFields(def.type, ctx);
        if (fields) {
          ctx.structClones.set(def.name, `__clone__${def.name}`);
        }
      }
      if (d.baseType && d.baseType.kind === 'struct' && d.baseType.tag) {
        ctx.structs.set(d.baseType.tag, d.baseType.fields);
      }
    } else if (d.kind === 'StructDecl' && d.tag) {
      ctx.structs.set(d.tag, d.fields);
    } else if (d.kind === 'FuncDecl' || d.kind === 'FuncProto') {
      ctx.functions.set(d.name, {
        returnType: d.returnType,
        paramTypes: d.params.map(p => p.type),
      });
    }
  }
}

function resolveType(t, ctx) {
  let cur = t;
  let safety = 32;
  while (cur && cur.kind === 'named' && safety-- > 0) {
    const next = ctx.typedefs.get(cur.name);
    if (!next) break;
    cur = next;
  }
  return cur;
}

function isPtr(t) { return t && t.kind === 'pointer'; }
function isArray(t) { return t && t.kind === 'array'; }
function isStruct(t, ctx) {
  const r = resolveType(t, ctx);
  return !!(r && r.kind === 'struct');
}
function getStructFields(t, ctx) {
  const r = resolveType(t, ctx);
  if (r && r.kind === 'struct') return r.fields;
  return null;
}
function elemType(t) {
  if (isPtr(t)) return t.target;
  if (isArray(t)) return t.element;
  return null;
}

function isBase(t, name) {
  return t && t.kind === 'base' && t.name === name;
}
function isCharType(t) { return isBase(t, 'char'); }
function isDoubleType(t) { return isBase(t, 'double'); }

function typedArrayCtor(elemT) {
  if (!elemT) return 'Array';
  if (elemT.kind === 'base') {
    switch (elemT.name) {
      case 'char': return 'Uint8Array';
      case 'double': return 'Float64Array';
      case 'float': return 'Float32Array';
      case 'int': return 'Int32Array';
      default: return 'Array';
    }
  }
  return 'Array';
}

// Element-type predicate for the monomorphic `__rt_at` / `__rt_setAt`
// fast path. True for pointers/arrays whose element is a pure numeric
// scalar — double, float, int (covers short/long via parser collapse),
// bool. Excludes char* (string literals may flow through), void*, and
// pointer-to-anything-else (struct fields, function pointers).
function isNumericElem(elemT) {
  if (!elemT || elemT.kind !== 'base') return false;
  return elemT.name === 'double' || elemT.name === 'float'
      || elemT.name === 'int' || elemT.name === 'bool';
}

// ============================================================
// Top-level emission
// ============================================================

function genTopLevel(d, ctx) {
  switch (d.kind) {
    case 'TypedefDecl': return genTypedefDecl(d, ctx);
    case 'StructDecl': return genStructDecl(d, ctx);
    case 'EnumDecl': return ''; // values were already captured by parser into expressions
    case 'FuncDecl': return genFuncDecl(d, ctx);
    case 'FuncProto': return '';
    case 'VarDecl': {
      const scope = newScope(null);
      return genVarDecl(d, scope, ctx);
    }
    default: return `// unhandled top-level: ${d.kind}`;
  }
}

function genTypedefDecl(d, ctx) {
  let out = '';
  for (const def of d.defs) {
    const fields = getStructFields(def.type, ctx);
    if (fields) {
      out += emitStructCloneFn(def.name, fields, ctx);
    }
  }
  return out;
}

function genStructDecl(d, ctx) {
  // We don't need to emit anything in JS for plain struct decls;
  // fields are accessed by name on JS objects.
  return '';
}

function emitStructCloneFn(typedefName, fields, ctx) {
  const fnName = `__clone__${typedefName}`;
  let s = `function ${fnName}(s) { return {\n`;
  for (const f of fields) {
    if (isArray(f.type)) {
      // Struct array fields are stored as `__rt_Ptr.wrap(new TypedArray(...))`
      // so the monomorphic `__rt_at` fast path can index them. Clone by
      // copying the underlying buffer and rewrapping; preserves both
      // representation and value semantics.
      s += `  ${f.name}: s.${f.name} == null ? null : __rt_Ptr.wrap(s.${f.name}.b.slice()),\n`;
    } else {
      s += `  ${f.name}: s.${f.name},\n`;
    }
  }
  s += `}; }\n`;
  return s;
}

// ============================================================
// Scopes
// ============================================================

function newScope(parent) {
  return { parent, vars: new Map(), boxed: parent ? parent.boxed : new Set() };
}
function scopeDefine(scope, name, type) {
  scope.vars.set(name, type);
}
function scopeLookup(scope, name) {
  let s = scope;
  while (s) {
    if (s.vars.has(name)) return s.vars.get(name);
    s = s.parent;
  }
  return null;
}
function isBoxed(scope, name) {
  return scope.boxed && scope.boxed.has(name);
}

// Walk a function body AST and collect names of scalar locals whose address
// is taken with `&`. Those need to be boxed so callees can write through the
// pointer (output parameter pattern: `void f(int *out) { *out = ... }`
// called as `f(&local)`).
function collectAddressedScalars(body, paramTypes) {
  const addressed = new Set();
  walk(body);
  return addressed;

  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (n.kind === 'Unary' && n.prefix && n.op === '&' && n.operand && n.operand.kind === 'Ident') {
      addressed.add(n.operand.name);
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  }
}

// ============================================================
// Functions
// ============================================================

// Functions defined in mtoc2's C runtime that c2js skips translating
// because the JS runtime (runtime.js) provides authoritative
// replacements operating on `{re, im}` plain objects. Translating
// the C bodies would either duplicate-define or — worse — produce JS
// that references `creal/cimag/I` semantics c2js can't honor without
// expression-level type tracking. The skip is purely textual: any
// call from user code to one of these names resolves to the runtime
// version at execution time.
const COMPLEX_SKIP_FUNCS = new Set([
  'mtoc2_cmake', 'mtoc2_creal', 'mtoc2_cimag',
  'mtoc2_cadd', 'mtoc2_csub', 'mtoc2_cmul', 'mtoc2_cneg', 'mtoc2_cconj',
  'mtoc2_cabs', 'mtoc2_cangle', 'mtoc2_cnonzero', 'mtoc2_ceq', 'mtoc2_cne', 'mtoc2_cpow',
  'mtoc2_cdiv',
  'mtoc2_format_complex', 'mtoc2_disp_complex',
  // The disp-tensor-complex pair holds onto bare `_Complex` locals
  // (it materializes a `double _Complex z = mtoc2_cmake(re[i], im[i])`
  // per cell before handing off to mtoc2_format_complex). The JS
  // runtime ships a hand-written implementation; c2js skip-
  // translates the C body. Every OTHER complex-tensor helper
  // (`_alloc`/`_alloc_nd`/`_copy`/`_from_row`/`_from_matrix`) was
  // rewritten in Phase 2 to take `double[]` lanes and use
  // `mtoc2_creal`/`mtoc2_cimag` for any necessary projections, so
  // c2js can translate them straight from C.
  'mtoc2_disp_tensor_complex',
  'mtoc2__disp_complex_slice',
]);

// C99 `<complex.h>` function names. If a non-skip-listed function
// calls any of these directly, mtoc2 has emitted native-complex C
// that c2js can't translate (we'd produce JS calling an undefined
// global, which only errors at runtime — much harder to diagnose
// than a translate-time throw). mtoc2's emit layer should be routing
// every scalar-complex op through the `mtoc2_c*` helpers in
// `cscalar.h`; the throw flags a regression.
//
// What's NOT in this set, and why:
//   - `_Complex` as a type-spec: mtoc2 still predeclares scalar
//     complex locals as `double _Complex z = 0.0;`. The c2js parser
//     collapses `_Complex` into the `double` base type and emits a
//     plain `let z = 0.0;`. The JS-side `mtoc2_c*` helpers tolerate
//     number-vs-object args, so first-write assignments through the
//     helpers upgrade `z` to a `{re, im}` object transparently.
//   - The identifiers `I` / `_Complex_I`: `I` is a legitimate user
//     variable name (e.g. `I = eye(3)` in test_scripts/mtimes.m).
//     mtoc2 doesn't emit bare `I` into user code; if it ever did,
//     the resulting JS would either ReferenceError at runtime or
//     produce NaN — acceptable failure mode for an unlikely
//     regression that no bare-ident scan can cleanly distinguish.
const BARE_COMPLEX_FUNCS = new Set([
  'creal', 'cimag', 'conj', 'cabs', 'carg', 'cproj',
  'cpow', 'csqrt', 'cexp', 'clog',
  'csin', 'ccos', 'ctan', 'casin', 'cacos', 'catan',
  'csinh', 'ccosh', 'ctanh', 'casinh', 'cacosh', 'catanh',
]);

function requireNoBareComplexCalls(d) {
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (n.kind === 'Call' && n.callee && n.callee.kind === 'Ident'
        && BARE_COMPLEX_FUNCS.has(n.callee.name)) {
      throw new Error(
        `c2js: function '${d.name}' calls C99 complex helper ` +
        `'${n.callee.name}' directly, which the JS backend cannot ` +
        `translate. Route through the mtoc2_c* helpers in cscalar.h ` +
        `(e.g. mtoc2_${n.callee.name}) — quietly emitting the call ` +
        `would surface as an undefined-global ReferenceError at run ` +
        `time, or worse, as NaN-producing arithmetic.`
      );
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object') walk(v);
    }
  })(d.body);
}

function genFuncDecl(d, ctx) {
  if (COMPLEX_SKIP_FUNCS.has(d.name)) {
    return `// ${d.name}: skipped — provided by JS runtime`;
  }
  requireNoBareComplexCalls(d);
  const scope = newScope(null);
  // Tag scalar locals/params whose address is taken — they need a Ptr box
  // so callees can write through the pointer.
  scope.boxed = collectAddressedScalars(d.body, d.params.map(p => p.type));
  const params = [];
  let preBody = '';
  for (const p of d.params) {
    scopeDefine(scope, p.name, p.type);
    params.push(safeId(p.name));
    if (isBoxed(scope, p.name) && !isStruct(p.type, ctx) && !isArray(p.type) && !isPtr(p.type)) {
      // Wrap incoming scalar argument in a Ptr-box on function entry.
      preBody += `  ${safeId(p.name)} = __rt_Ptr.wrap([${safeId(p.name)}], 0);\n`;
    }
  }
  const body = genBlock(d.body, scope, ctx, /*topLevel*/ true);
  // Splice preBody just after the opening `{`.
  const bodyWithPre = preBody ? body.replace(/^\{\n/, `{\n${preBody}`) : body;
  return `function ${safeId(d.name)}(${params.join(', ')}) ${bodyWithPre}`;
}

function genBlock(block, scope, ctx, topLevel = false) {
  ctx.indent++;
  const inner = topLevel ? scope : newScope(scope);
  const stmts = block.stmts.map(s => genStmt(s, inner, ctx)).join('');
  ctx.indent--;
  const pad = '  '.repeat(ctx.indent);
  return `{\n${stmts}${pad}}`;
}

function pad(ctx) { return '  '.repeat(ctx.indent); }

// ============================================================
// Statements
// ============================================================

function genStmt(s, scope, ctx) {
  if (Array.isArray(s)) return s.map(x => genStmt(x, scope, ctx)).join('');
  const p = pad(ctx);
  switch (s.kind) {
    case 'EmptyStmt': return p + ';\n';
    case 'Block': return p + genBlock(s, scope, ctx) + '\n';
    case 'VarDecl': return genVarDecl(s, scope, ctx);
    case 'If': return genIf(s, scope, ctx);
    case 'For': return genFor(s, scope, ctx);
    case 'While': return genWhile(s, scope, ctx);
    case 'DoWhile': return genDoWhile(s, scope, ctx);
    case 'Switch': return genSwitch(s, scope, ctx);
    case 'Return': return genReturn(s, scope, ctx);
    case 'Break': return p + 'break;\n';
    case 'Continue': return p + 'continue;\n';
    case 'ExprStmt': return p + emitExpr(s.expr, scope, ctx).js + ';\n';
    case 'EnumDecl': return '';
    case 'TypedefDecl': return genTypedefDecl(s, ctx);
    default: return p + `// unhandled stmt: ${s.kind}\n`;
  }
}

function genVarDecl(d, scope, ctx) {
  scopeDefine(scope, d.name, d.type);
  const p = pad(ctx);
  let initJs = genVarInit(d, scope, ctx);
  if (isBoxed(scope, d.name) && !isStruct(d.type, ctx) && !isArray(d.type) && !isPtr(d.type)) {
    initJs = `__rt_Ptr.wrap([${initJs}], 0)`;
  }
  return `${p}let ${safeId(d.name)} = ${initJs};\n`;
}

function genVarInit(d, scope, ctx) {
  // Arrays of fixed size (T name[N])
  if (isArray(d.type)) {
    const elT = d.type.element;
    const ctor = typedArrayCtor(elT);
    let sizeJs = '0';
    if (d.type.size) sizeJs = emitExpr(d.type.size, scope, ctx).js;
    const sizeVal = evalConstSize(d.type.size);
    // initializer list?
    if (d.init) {
      if (d.init.kind === 'InitList') {
        const elems = d.init.elems.map(e => emitInitElem(e, elT, scope, ctx));
        // C semantics: `T arr[N] = {a, b};` zero-fills positions [2, N).
        // `T arr[N] = {0};` is the common idiom for "zero-fill all N".
        // We must respect the declared size, not just the init-list length.
        if (sizeVal > 0 && elems.length < sizeVal) {
          const zero = (isBase(elT, 'double') || isBase(elT, 'float')) ? '0.0' : '0';
          while (elems.length < sizeVal) elems.push(zero);
        }
        const joined = elems.join(', ');
        if (ctor === 'Array') return `__rt_Ptr.wrap([${joined}])`;
        return `__rt_Ptr.wrap(new ${ctor}([${joined}]))`;
      }
      const initJs = emitExpr(d.init, scope, ctx).js;
      return initJs;
    }
    if (ctor === 'Array') return `__rt_Ptr.wrap(new Array(${sizeJs}).fill(0))`;
    return `__rt_Ptr.wrap(new ${ctor}(${sizeJs}))`;
  }

  if (d.init) {
    const initE = emitExpr(d.init, scope, ctx);
    // Initializer list for struct
    if (d.init.kind === 'InitList') {
      const fields = getStructFields(d.type, ctx);
      if (fields) {
        return emitStructInitList(d.init, fields, scope, ctx);
      }
      // Otherwise array-like initialization; treat as Ptr.
      return initE.js;
    }
    // Struct copy semantics: T x = y;
    if (isStruct(d.type, ctx) && shouldCloneOnAssign(d.init, scope, ctx)) {
      const typedefName = d.type.kind === 'named' ? d.type.name : null;
      if (typedefName && ctx.structClones.has(typedefName)) {
        return `__clone__${typedefName}(${initE.js})`;
      }
      return `Object.assign({}, ${initE.js})`;
    }
    return initE.js;
  }

  // No initializer — default by type
  if (isPtr(d.type)) return 'null';
  if (isStruct(d.type, ctx)) {
    return emitStructDefault(d.type, ctx);
  }
  if (isBase(d.type, 'double') || isBase(d.type, 'float')) return '0.0';
  return '0';
}

function newArrayJs(ctor, sz) {
  // Allocate a default-filled array of the given JS constructor. Returns
  // a `__rt_Ptr`-wrapped buffer in all cases so that downstream code can
  // use the monomorphic `__rt_at` / `__rt_setAt` fast path. (If we left
  // typed-array fields bare, the fast path would have to branch on
  // `instanceof __rt_Ptr` and V8 would deoptimize to the slow path.)
  if (ctor === 'Array') return `__rt_Ptr.wrap(new Array(${sz}).fill(0))`;
  return `__rt_Ptr.wrap(new ${ctor}(${sz}))`;
}

function emitStructDefault(t, ctx) {
  const fields = getStructFields(t, ctx);
  if (!fields) return '{}';
  const parts = [];
  for (const f of fields) {
    if (isArray(f.type)) {
      const sz = f.arraySize ? evalConstSize(f.arraySize) : 0;
      const ctor = typedArrayCtor(f.type.element);
      parts.push(`${f.name}: ${newArrayJs(ctor, sz)}`);
    } else if (isPtr(f.type)) {
      parts.push(`${f.name}: null`);
    } else if (isStruct(f.type, ctx)) {
      parts.push(`${f.name}: ${emitStructDefault(f.type, ctx)}`);
    } else if (isBase(f.type, 'double') || isBase(f.type, 'float')) {
      parts.push(`${f.name}: 0.0`);
    } else {
      parts.push(`${f.name}: 0`);
    }
  }
  return `{ ${parts.join(', ')} }`;
}

function evalConstSize(e) {
  if (!e) return 0;
  if (e.kind === 'Num') return e.value;
  // We pre-replaced enum constants in the parser, so most sizes are Num.
  return 0;
}

function emitStructInitList(init, fields, scope, ctx) {
  // Detect designated init: all elems with named designators.
  const hasDesignators = init.elems.some(e => e && e.kind === 'Designator' && e.name);
  if (hasDesignators) {
    const parts = [];
    const seen = new Set();
    for (const elem of init.elems) {
      if (!elem || elem.kind !== 'Designator' || !elem.name) continue;
      const f = fields.find(ff => ff.name === elem.name);
      seen.add(elem.name);
      const eJs = emitInitValueForField(elem.value, f, scope, ctx);
      parts.push(`${elem.name}: ${eJs}`);
    }
    // Fill remaining with defaults so result has all fields.
    for (const f of fields) {
      if (seen.has(f.name)) continue;
      parts.push(`${f.name}: ${defaultJsForField(f, ctx)}`);
    }
    return `{ ${parts.join(', ')} }`;
  }
  // Positional init list maps to struct fields in order.
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const e = init.elems[i];
    if (e === undefined) {
      parts.push(`${f.name}: ${defaultJsForField(f, ctx)}`);
      continue;
    }
    parts.push(`${f.name}: ${emitInitValueForField(e, f, scope, ctx)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function emitInitValueForField(e, f, scope, ctx) {
  if (!f) return emitExpr(e, scope, ctx).js;
  if (isArray(f.type) && e.kind === 'InitList') {
    const ctor = typedArrayCtor(f.type.element);
    const sz = evalConstSize(f.arraySize);
    const items = e.elems.map(x => emitExpr(x, scope, ctx).js);
    while (items.length < sz) items.push('0');
    const body = ctor === 'Array' ? `[${items.join(', ')}]` : `new ${ctor}([${items.join(', ')}])`;
    return `__rt_Ptr.wrap(${body})`;
  }
  if (isStruct(f.type, ctx) && e.kind === 'InitList') {
    return emitStructInitList(e, getStructFields(f.type, ctx), scope, ctx);
  }
  return emitExpr(e, scope, ctx).js;
}

function defaultJsForField(f, ctx) {
  if (isArray(f.type)) {
    const sz = evalConstSize(f.arraySize);
    const ctor = typedArrayCtor(f.type.element);
    return newArrayJs(ctor, sz);
  }
  if (isPtr(f.type)) return 'null';
  if (isStruct(f.type, ctx)) return emitStructDefault(f.type, ctx);
  if (isBase(f.type, 'double') || isBase(f.type, 'float')) return '0.0';
  return '0';
}

function emitInitElem(e, elT, scope, ctx) {
  if (e.kind === 'InitList') {
    // nested initializer
    const items = e.elems.map(x => emitInitElem(x, elemType(elT) || elT, scope, ctx));
    return `[${items.join(', ')}]`;
  }
  return emitExpr(e, scope, ctx).js;
}

function shouldCloneOnAssign(e, scope, ctx) {
  // Don't clone if RHS already constructs a fresh struct value.
  if (!e) return false;
  if (e.kind === 'Call') return false;
  if (e.kind === 'CompoundLit') return false;
  if (e.kind === 'InitList') return false;
  return true;
}

// ============================================================
// Control flow
// ============================================================

function genIf(s, scope, ctx) {
  const p = pad(ctx);
  const c = emitExpr(s.cond, scope, ctx).js;
  let out = `${p}if (${toBool(c, s.cond, scope, ctx)}) `;
  out += genStmtAsBlock(s.then, scope, ctx);
  if (s.else) {
    out = out.replace(/\n$/, '');
    out += ` else `;
    if (s.else.kind === 'If') {
      // chain: drop the brace newline, emit recursively
      const elseStr = genIf(s.else, scope, ctx);
      out += elseStr.trimStart();
      return out;
    }
    out += genStmtAsBlock(s.else, scope, ctx);
  }
  return out;
}

function genStmtAsBlock(s, scope, ctx) {
  if (s.kind === 'Block') {
    return genBlock(s, scope, ctx) + '\n';
  }
  const inner = newScope(scope);
  ctx.indent++;
  const body = genStmt(s, inner, ctx);
  ctx.indent--;
  const p = pad(ctx);
  return `{\n${body}${p}}\n`;
}

function genFor(s, scope, ctx) {
  const p = pad(ctx);
  const inner = newScope(scope);
  let initJs = '';
  if (s.init) {
    if (Array.isArray(s.init)) {
      // VarDecls
      const parts = s.init.map(d => {
        scopeDefine(inner, d.name, d.type);
        const initE = d.init ? emitExpr(d.init, inner, ctx).js : '0';
        return `${safeId(d.name)} = ${initE}`;
      });
      initJs = 'let ' + parts.join(', ');
    } else {
      initJs = emitExpr(s.init, inner, ctx).js;
    }
  }
  const condJs = s.cond ? toBool(emitExpr(s.cond, inner, ctx).js, s.cond, inner, ctx) : '';
  const stepJs = s.step ? emitExpr(s.step, inner, ctx).js : '';
  let out = `${p}for (${initJs}; ${condJs}; ${stepJs}) `;
  out += genStmtAsBlock(s.body, inner, ctx);
  return out;
}

function genWhile(s, scope, ctx) {
  const p = pad(ctx);
  const c = toBool(emitExpr(s.cond, scope, ctx).js, s.cond, scope, ctx);
  return `${p}while (${c}) ` + genStmtAsBlock(s.body, scope, ctx);
}

function genDoWhile(s, scope, ctx) {
  const p = pad(ctx);
  const c = toBool(emitExpr(s.cond, scope, ctx).js, s.cond, scope, ctx);
  let out = `${p}do `;
  out += genStmtAsBlock(s.body, scope, ctx).replace(/\n$/, '');
  out += ` while (${c});\n`;
  return out;
}

function genSwitch(s, scope, ctx) {
  const p = pad(ctx);
  const disc = emitExpr(s.disc, scope, ctx).js;
  let out = `${p}switch (${disc}) {\n`;
  ctx.indent++;
  for (const cs of s.cases) {
    const pp = pad(ctx);
    if (cs.value === null) out += `${pp}default:\n`;
    else out += `${pp}case ${emitExpr(cs.value, scope, ctx).js}:\n`;
    ctx.indent++;
    for (const st of cs.stmts) out += genStmt(st, scope, ctx);
    ctx.indent--;
  }
  ctx.indent--;
  out += `${p}}\n`;
  return out;
}

function genReturn(s, scope, ctx) {
  const p = pad(ctx);
  if (!s.value) return `${p}return;\n`;
  return `${p}return ${emitExpr(s.value, scope, ctx).js};\n`;
}

// ============================================================
// Expressions — emit returns {js, type}
// ============================================================

function emitExpr(e, scope, ctx) {
  switch (e.kind) {
    case 'Num': return { js: numLitJs(e), type: { kind: 'base', name: e.isFloat ? 'double' : 'int' } };
    case 'Str': return { js: JSON.stringify(e.value), type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'Chr': return { js: String(e.value), type: { kind: 'base', name: 'char' } };
    case 'Ident': return emitIdent(e, scope, ctx);
    case 'Binary': return emitBinary(e, scope, ctx);
    case 'Unary': return emitUnary(e, scope, ctx);
    case 'Assign': return emitAssign(e, scope, ctx);
    case 'Cond': return emitCond(e, scope, ctx);
    case 'Call': return emitCall(e, scope, ctx);
    case 'Member': return emitMember(e, scope, ctx);
    case 'Index': return emitIndex(e, scope, ctx);
    case 'Cast': return emitCast(e, scope, ctx);
    case 'Sizeof': return emitSizeof(e, scope, ctx);
    case 'CompoundLit': return emitCompoundLit(e, scope, ctx);
    case 'Comma': {
      const a = emitExpr(e.left, scope, ctx);
      const b = emitExpr(e.right, scope, ctx);
      return { js: `(${a.js}, ${b.js})`, type: b.type };
    }
    case 'StmtExpr': return emitStmtExpr(e, scope, ctx);
    default: return { js: `/* ?${e.kind} */`, type: null };
  }
}

function numLitJs(e) {
  if (!isFinite(e.value)) return String(e.value);
  if (e.isFloat) {
    let s = String(e.value);
    if (!s.includes('.') && !s.includes('e') && !s.includes('E')) s += '.0';
    return s;
  }
  return String(e.value);
}

function emitIdent(e, scope, ctx) {
  // Special identifiers
  if (e.name === 'NULL') return { js: 'null', type: { kind: 'pointer', target: { kind: 'base', name: 'void' } } };
  if (e.name === 'SIZE_MAX') return { js: 'Number.MAX_SAFE_INTEGER', type: { kind: 'base', name: 'int' } };
  if (e.name === 'INT_MAX') return { js: '2147483647', type: { kind: 'base', name: 'int' } };
  if (e.name === 'INT_MIN') return { js: '(-2147483648)', type: { kind: 'base', name: 'int' } };
  if (e.name === 'stdout') return { js: "'stdout'", type: { kind: 'pointer', target: { kind: 'named', name: 'FILE' } } };
  if (e.name === 'stderr') return { js: "'stderr'", type: { kind: 'pointer', target: { kind: 'named', name: 'FILE' } } };
  if (e.name === 'true') return { js: 'true', type: { kind: 'base', name: 'int' } };
  if (e.name === 'false') return { js: 'false', type: { kind: 'base', name: 'int' } };

  const t = scopeLookup(scope, e.name);
  if (t) {
    if (isBoxed(scope, e.name) && !isStruct(t, ctx) && !isArray(t) && !isPtr(t)) {
      return { js: `__rt_Ptr.load(${safeId(e.name)})`, type: t };
    }
    return { js: safeId(e.name), type: t };
  }

  // Could be a function name.
  if (ctx.functions.has(e.name)) {
    return { js: safeId(e.name), type: { kind: 'function', name: e.name } };
  }
  return { js: safeId(e.name), type: null };
}

function emitBinary(e, scope, ctx) {
  const L = emitExpr(e.left, scope, ctx);
  const R = emitExpr(e.right, scope, ctx);
  const lt = L.type, rt = R.type;
  const op = e.op;

  // Pointer arithmetic: ptr + int → Ptr_add(ptr, int)
  if ((isPtr(lt) || isArray(lt)) && (op === '+' || op === '-')) {
    if (op === '-' && (isPtr(rt) || isArray(rt))) {
      // pointer difference (element count)
      return { js: `__rt_Ptr.diff(${L.js}, ${R.js})`, type: { kind: 'base', name: 'int' } };
    }
    return { js: `__rt_Ptr.${op === '+' ? 'add' : 'sub'}(${L.js}, ${R.js})`, type: lt };
  }
  if ((isPtr(rt) || isArray(rt)) && op === '+') {
    return { js: `__rt_Ptr.add(${R.js}, ${L.js})`, type: rt };
  }
  // Pointer comparisons
  const cmpOps = new Set(['<', '<=', '>', '>=', '==', '!=']);
  if ((isPtr(lt) || isArray(lt) || isPtr(rt) || isArray(rt)) && cmpOps.has(op)) {
    // Allow comparison against NULL / 0 — fall back to ?? offset comparison.
    if ((R.js === '0' || R.js === 'null') && op === '==') return { js: `(${L.js} == null)`, type: { kind: 'base', name: 'int' } };
    if ((R.js === '0' || R.js === 'null') && op === '!=') return { js: `(${L.js} != null)`, type: { kind: 'base', name: 'int' } };
    if ((L.js === '0' || L.js === 'null') && op === '==') return { js: `(${R.js} == null)`, type: { kind: 'base', name: 'int' } };
    if ((L.js === '0' || L.js === 'null') && op === '!=') return { js: `(${R.js} != null)`, type: { kind: 'base', name: 'int' } };
    return { js: `__rt_Ptr.cmp(${L.js}, ${R.js}, ${JSON.stringify(op)})`, type: { kind: 'base', name: 'int' } };
  }

  // Logical
  if (op === '&&' || op === '||') {
    const lb = toBool(L.js, e.left, scope, ctx);
    const rb = toBool(R.js, e.right, scope, ctx);
    const js = `((${lb}) ${op} (${rb}) ? 1 : 0)`;
    return { js, type: { kind: 'base', name: 'int' } };
  }

  // Integer division — C truncates toward zero
  if (op === '/' && isIntegralType(lt) && isIntegralType(rt)) {
    return { js: `Math.trunc((${L.js}) / (${R.js}))`, type: lt };
  }
  if (op === '%' && isIntegralType(lt) && isIntegralType(rt)) {
    return { js: `((${L.js}) % (${R.js}))`, type: lt };
  }

  // Bitshift — coerce result to 32-bit signed (C semantics for int)
  if (op === '<<' || op === '>>') {
    return { js: `((${L.js}) ${op} (${R.js}))`, type: lt };
  }

  // Standard arithmetic
  return { js: `((${L.js}) ${op} (${R.js}))`, type: promoteType(lt, rt) };
}

function isIntegralType(t) {
  if (!t) return false;
  if (t.kind !== 'base') return false;
  return t.name === 'int' || t.name === 'char' || t.name === 'bool';
}
function promoteType(a, b) {
  if (isBase(a, 'double') || isBase(b, 'double')) return { kind: 'base', name: 'double' };
  if (isBase(a, 'float') || isBase(b, 'float')) return { kind: 'base', name: 'float' };
  return a || b;
}

function toBool(js, e, scope, ctx) {
  if (!e) return js;
  // Pointer truthiness: NULL is false. In our runtime, null is a possible value.
  // Just rely on JS truthiness for now (0 is false; null/undefined are false; Ptr is truthy).
  return js;
}

function emitUnary(e, scope, ctx) {
  if (e.prefix) {
    if (e.op === '&') {
      // & of a boxed scalar local: return the box itself.
      if (e.operand.kind === 'Ident' && isBoxed(scope, e.operand.name)) {
        const t = scopeLookup(scope, e.operand.name);
        return { js: safeId(e.operand.name), type: { kind: 'pointer', target: t } };
      }
      const op = emitExpr(e.operand, scope, ctx);
      // & of struct/array: the value itself is already a reference in JS.
      if (isStruct(op.type, ctx) || isArray(op.type)) {
        return { js: op.js, type: { kind: 'pointer', target: op.type } };
      }
      return { js: `/* &(${op.js}) unsupported */ null`, type: { kind: 'pointer', target: op.type } };
    }
    if (e.op === '*') {
      // dereference
      const op = emitExpr(e.operand, scope, ctx);
      const t = elemType(op.type);
      if (t && isStruct(t, ctx)) {
        return { js: op.js, type: t };
      }
      // numeric/char ptr: load through Ptr
      return { js: `__rt_Ptr.load(${op.js})`, type: t };
    }
    if (e.op === '!') {
      const op = emitExpr(e.operand, scope, ctx);
      return { js: `(!(${op.js}))`, type: { kind: 'base', name: 'int' } };
    }
    if (e.op === '-') {
      const op = emitExpr(e.operand, scope, ctx);
      return { js: `(-(${op.js}))`, type: op.type };
    }
    if (e.op === '+') {
      const op = emitExpr(e.operand, scope, ctx);
      return { js: `(+(${op.js}))`, type: op.type };
    }
    if (e.op === '~') {
      const op = emitExpr(e.operand, scope, ctx);
      return { js: `(~(${op.js}))`, type: op.type };
    }
    if (e.op === '++' || e.op === '--') {
      const d = e.op === '++' ? 1 : -1;
      // Prefix increment of `*p`: write back via the runtime ptr helper
      // (postIndexUpdate returns the old value, so add `d` for the new).
      // Without this the fallback below emits `++__rt_Ptr.load(p)`, which
      // is not a valid JS lvalue.
      if (e.operand.kind === 'Unary' && e.operand.prefix && e.operand.op === '*') {
        const ptr = emitExpr(e.operand.operand, scope, ctx);
        return { js: `(__rt_Ptr.postIndexUpdate(${ptr.js}, 0, ${d}) + ${d})`, type: elemType(ptr.type) };
      }
      const op = emitExpr(e.operand, scope, ctx);
      if (isPtr(op.type) || isArray(op.type)) {
        const fn = e.op === '++' ? 'add' : 'sub';
        return { js: `(${op.js} = __rt_Ptr.${fn}(${op.js}, 1))`, type: op.type };
      }
      return { js: `(${e.op}${op.js})`, type: op.type };
    }
  }
  // postfix ++/--
  const d = e.op === '++' ? 1 : -1;
  if (e.operand.kind === 'Index') {
    const obj = emitExpr(e.operand.object, scope, ctx);
    const idx = emitExpr(e.operand.index, scope, ctx);
    const elT = elemType(obj.type);
    return { js: `__rt_Ptr.postIndexUpdate(${obj.js}, ${idx.js}, ${d})`, type: elT };
  }
  if (e.operand.kind === 'Ident' && isBoxed(scope, e.operand.name)) {
    const t = scopeLookup(scope, e.operand.name);
    return { js: `__rt_Ptr.postIndexUpdate(${safeId(e.operand.name)}, 0, ${d})`, type: t };
  }
  // Postfix on a dereference `(*p)--`. Same routing as prefix above; the
  // helper returns the pre-update value, which is exactly what postfix
  // should yield. Without this the fallback emits `(__rt_Ptr.load(p)--)`,
  // which fails to parse as an lvalue.
  if (e.operand.kind === 'Unary' && e.operand.prefix && e.operand.op === '*') {
    const ptr = emitExpr(e.operand.operand, scope, ctx);
    return { js: `__rt_Ptr.postIndexUpdate(${ptr.js}, 0, ${d})`, type: elemType(ptr.type) };
  }
  const op = emitExpr(e.operand, scope, ctx);
  if (isPtr(op.type) || isArray(op.type)) {
    const fn = e.op === '++' ? 'add' : 'sub';
    return { js: `__rt_Ptr.postUpdate(()=>${op.js}, v => ${op.js} = v, ${JSON.stringify(fn)})`, type: op.type };
  }
  return { js: `(${op.js}${e.op})`, type: op.type };
}

function emitAssign(e, scope, ctx) {
  const target = emitExpr(e.target, scope, ctx);
  const value = emitExpr(e.value, scope, ctx);

  // Struct assignment via dereferenced pointer: *lhs = rhs
  if (e.target.kind === 'Unary' && e.target.prefix && e.target.op === '*' && isStruct(target.type, ctx)) {
    const inner = emitExpr(e.target.operand, scope, ctx);
    if (e.op === '=') {
      return { js: `Object.assign(${inner.js}, ${value.js})`, type: target.type };
    }
  }

  // Pointer-target write: *p = v  (numeric)
  if (e.target.kind === 'Unary' && e.target.prefix && e.target.op === '*' && !isStruct(target.type, ctx)) {
    const inner = emitExpr(e.target.operand, scope, ctx);
    return { js: `__rt_Ptr.store(${inner.js}, ${value.js})`, type: target.type };
  }

  // Indexed write through a pointer: p[i] = v
  if (e.target.kind === 'Index') {
    const objInfo = emitExpr(e.target.object, scope, ctx);
    const idx = emitExpr(e.target.index, scope, ctx);
    if (isPtr(objInfo.type) || isArrayPtr(objInfo.type)) {
      const et = elemType(objInfo.type);
      const fast = isNumericElem(et);
      const setFn = fast ? '__rt_setAt' : '__rt_Ptr.setAt';
      const atFn = fast ? '__rt_at' : '__rt_Ptr.at';
      if (e.op === '=') {
        return { js: `${setFn}(${objInfo.js}, ${idx.js}, ${value.js})`, type: target.type };
      }
      const rhsOp = e.op.slice(0, -1);
      return { js: `${setFn}(${objInfo.js}, ${idx.js}, ${atFn}(${objInfo.js}, ${idx.js}) ${rhsOp} (${value.js}))`, type: target.type };
    }
    // plain JS array/object indexing
    return { js: `(${objInfo.js})[${idx.js}] ${e.op} (${value.js})`, type: target.type };
  }

  // Assignment to a boxed scalar local: write through the Ptr.
  if (e.target.kind === 'Ident' && isBoxed(scope, e.target.name)) {
    const t = scopeLookup(scope, e.target.name);
    if (t && !isStruct(t, ctx) && !isArray(t) && !isPtr(t)) {
      const nameJs = safeId(e.target.name);
      if (e.op === '=') return { js: `__rt_Ptr.store(${nameJs}, ${value.js})`, type: t };
      const rhsOp = e.op.slice(0, -1);
      return { js: `__rt_Ptr.store(${nameJs}, __rt_Ptr.load(${nameJs}) ${rhsOp} (${value.js}))`, type: t };
    }
  }

  // Regular assignment to an lvalue (Ident / Member)
  // If both sides are structs (and not a fresh-creating call), clone the RHS.
  if (isStruct(target.type, ctx) && shouldCloneOnAssign(e.value, scope, ctx)) {
    const t = target.type;
    const typedefName = t && t.kind === 'named' ? t.name : null;
    if (typedefName && ctx.structClones.has(typedefName)) {
      return { js: `${target.js} = __clone__${typedefName}(${value.js})`, type: target.type };
    }
  }
  return { js: `${target.js} ${e.op} ${value.js}`, type: target.type };
}

function isArrayPtr(t) { return isPtr(t) || isArray(t); }

function emitStmtExpr(e, scope, ctx) {
  // GCC statement expression: ({ s1; s2; ...; final; }). The value of the
  // last expression-statement is the value of the whole expression.
  const inner = newScope(scope);
  const stmts = e.block.stmts.flat();
  let bodyJs = '';
  let retJs = 'undefined';
  let retType = null;
  ctx.indent++;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (i === stmts.length - 1 && s && s.kind === 'ExprStmt') {
      const v = emitExpr(s.expr, inner, ctx);
      retJs = v.js;
      retType = v.type;
    } else {
      bodyJs += genStmt(s, inner, ctx);
    }
  }
  ctx.indent--;
  const js = `(() => {\n${bodyJs}${pad(ctx)}  return ${retJs};\n${pad(ctx)}})()`;
  return { js, type: retType };
}

function emitCond(e, scope, ctx) {
  const c = emitExpr(e.cond, scope, ctx);
  const a = emitExpr(e.then, scope, ctx);
  const b = emitExpr(e.else, scope, ctx);
  return { js: `((${c.js}) ? (${a.js}) : (${b.js}))`, type: a.type || b.type };
}

function emitMember(e, scope, ctx) {
  const objInfo = emitExpr(e.object, scope, ctx);
  // arrow: object is a struct pointer (already a reference in JS), so use '.'
  const js = `${objInfo.js}.${e.prop}`;
  // Look up the field's type if we can.
  let parentType = objInfo.type;
  if (e.arrow) parentType = elemType(parentType) || parentType;
  const fields = parentType ? getStructFields(parentType, ctx) : null;
  let fieldType = null;
  if (fields) {
    const f = fields.find(x => x.name === e.prop);
    if (f) fieldType = f.type;
  }
  return { js, type: fieldType };
}

function emitIndex(e, scope, ctx) {
  const objInfo = emitExpr(e.object, scope, ctx);
  const idx = emitExpr(e.index, scope, ctx);
  if (isPtr(objInfo.type) || isArray(objInfo.type)) {
    const et = elemType(objInfo.type);
    if (isNumericElem(et)) {
      return { js: `__rt_at(${objInfo.js}, ${idx.js})`, type: et };
    }
    return { js: `__rt_Ptr.at(${objInfo.js}, ${idx.js})`, type: et };
  }
  return { js: `(${objInfo.js})[${idx.js}]`, type: null };
}

function emitCast(e, scope, ctx) {
  const src = emitExpr(e.expr, scope, ctx);
  const target = e.type;

  // Cast to integer types — truncate toward zero (works for values beyond int32 range too).
  if (isBase(target, 'int') || isBase(target, 'char')) {
    return { js: `Math.trunc(${src.js})`, type: target };
  }
  if (target.kind === 'named' && /^(size_t|ssize_t|u?int(8|16|32|64)_t|ptrdiff_t)$/.test(target.name)) {
    return { js: `Math.trunc(${src.js})`, type: target };
  }
  // Cast to double/float — no-op
  if (isBase(target, 'double') || isBase(target, 'float')) {
    return { js: `(+(${src.js}))`, type: target };
  }
  // Cast to pointer-of-T. If source is a malloc-like generic byte buffer, reinterpret.
  if (isPtr(target)) {
    const inner = target.target;
    // Cast to struct-pointer + the source is malloc/calloc: we need an array of
    // freshly-built struct objects, not raw zero slots. C's `T *p = (T *)malloc(N*sizeof(T));`
    // followed by `p[i].field = ...` only works because the bytes back valid struct
    // storage; in JS we must seed each slot with `{field: default, ...}`.
    if (isStruct(inner, ctx)) {
      const m = src.js.match(/^__rt_(malloc|calloc)\(([\s\S]*)\)$/);
      if (m) {
        const sizeArg = m[1] === 'malloc' ? m[2] : `(${m[2]})`.replace(/\(\s*([^,]+),\s*([^)]+)\s*\)/, '($1)*($2)');
        const fields = getStructFields(inner, ctx);
        let defaults = '';
        if (fields) {
          defaults = fields.map(f => `${f.name}: ${defaultJsForField(f, ctx)}`).join(', ');
        }
        return { js: `__rt_Ptr.wrap(Array.from({length: ${sizeArg}}, () => ({${defaults}})))`, type: target };
      }
      return { js: src.js, type: target };
    }
    const tac = typedArrayCtor(inner);
    if (tac && tac !== 'Array') {
      // If the source is a fresh `__rt_malloc(N)` or `__rt_calloc(N, S)`,
      // allocate the right typed array directly — much faster than a
      // boxed JS `Array` and lets the monomorphic `__rt_at` fast path
      // specialize on a single hidden class for `p.b`.
      const m = src.js.match(/^__rt_(malloc|calloc)\(([\s\S]*)\)$/);
      if (m) {
        let n;
        if (m[1] === 'malloc') {
          n = m[2];
        } else {
          // calloc(n, size) → element count is n*size. The arg list
          // came from `emitStdCall` which already joined `n, size` with
          // a comma at the top level, so a regex split is safe.
          const comma = splitTopLevelComma(m[2]);
          if (comma) n = `(${comma[0]})*(${comma[1]})`;
          else n = m[2];
        }
        return { js: `__rt_Ptr.wrap(new ${tac}(${n}))`, type: target };
      }
      return { js: `__rt_reinterpretPtr(${src.js}, ${JSON.stringify(tac)})`, type: target };
    }
    return { js: src.js, type: target };
  }
  return { js: src.js, type: target };
}

// Split a comma-separated argument list at top-level commas only
// (ignoring commas nested inside parens / brackets / braces). Returns
// the two-element split for the two-arg case, or null if there isn't
// exactly one top-level comma. Used by the calloc-cast emitter to
// recover the original (n, size) args from the joined string.
function splitTopLevelComma(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      const a = s.slice(0, i).trim();
      const b = s.slice(i + 1).trim();
      if (!a || !b) return null;
      // Ensure no second top-level comma.
      for (let j = i + 1; j < s.length; j++) {
        const c2 = s[j];
        if (c2 === '(' || c2 === '[' || c2 === '{') depth++;
        else if (c2 === ')' || c2 === ']' || c2 === '}') depth--;
        else if (c2 === ',' && depth === 0) return null;
      }
      return [a, b];
    }
  }
  return null;
}

function emitSizeof(e, scope, ctx) {
  // We treat sizeof(T) as 1 element. sizeof(arr) returns the array length × 1.
  if (e.target.kind === 'type') return { js: '1', type: { kind: 'base', name: 'int' } };
  const inner = emitExpr(e.target.expr, scope, ctx);
  if (isArray(inner.type)) {
    return { js: `__rt_sizeofArr(${inner.js})`, type: { kind: 'base', name: 'int' } };
  }
  return { js: '1', type: { kind: 'base', name: 'int' } };
}

function emitCompoundLit(e, scope, ctx) {
  // (type){ initializer-list }
  const t = e.type;
  if (isArray(t)) {
    const elT = t.element;
    const ctor = typedArrayCtor(elT);
    if (e.init.kind === 'InitList') {
      const items = e.init.elems.map(x => {
        if (x && x.kind === 'InitList' && isStruct(elT, ctx)) {
          return emitStructInitList(x, getStructFields(elT, ctx), scope, ctx);
        }
        return emitExpr(x, scope, ctx).js;
      }).join(', ');
      if (ctor === 'Array') return { js: `__rt_Ptr.wrap([${items}])`, type: t };
      return { js: `__rt_Ptr.wrap(new ${ctor}([${items}]))`, type: t };
    }
    return { js: `__rt_Ptr.wrap([])`, type: t };
  }
  if (isStruct(t, ctx) && e.init.kind === 'InitList') {
    const fields = getStructFields(t, ctx);
    return { js: emitStructInitList(e.init, fields, scope, ctx), type: t };
  }
  // single-value compound literal
  return emitExpr(e.init, scope, ctx);
}

// ============================================================
// Function calls — including special cases for stdlib funcs
// ============================================================

function emitCall(e, scope, ctx) {
  // Try to handle special stdlib calls
  if (e.callee.kind === 'Ident') {
    const name = e.callee.name;
    const args = e.args.map(a => emitExpr(a, scope, ctx));

    switch (name) {
      case 'printf':
      case 'fprintf':
      case 'snprintf':
      case 'fputs':
      case 'putchar':
      case 'fwrite':
      case 'malloc':
      case 'calloc':
      case 'realloc':
      case 'free':
      case 'memcpy':
      case 'memmove':
      case 'memset':
      case 'strlen':
      case 'strchr':
      case 'strcmp':
      case 'strcpy':
      case 'atoi':
      case 'atof':
      case 'abort':
      case 'isnan':
      case 'isinf':
      case 'fabs':
      case 'floor':
      case 'ceil':
      case 'sqrt':
      case 'exit':
      case 'puts':
        return emitStdCall(name, e.args, args, scope, ctx);
    }

    // Look up user function
    const fn = ctx.functions.get(name);
    if (fn) {
      const argJs = args.map(a => a.js).join(', ');
      return { js: `${safeId(name)}(${argJs})`, type: fn.returnType };
    }
    // Unknown — emit literally
    const argJs = args.map(a => a.js).join(', ');
    return { js: `${safeId(name)}(${argJs})`, type: null };
  }
  // Indirect calls (function pointers) — not supported
  const callee = emitExpr(e.callee, scope, ctx);
  const argJs = e.args.map(a => emitExpr(a, scope, ctx).js).join(', ');
  return { js: `${callee.js}(${argJs})`, type: null };
}

function emitStdCall(name, rawArgs, args, scope, ctx) {
  const argJs = args.map(a => a.js).join(', ');
  switch (name) {
    case 'printf':       return { js: `__rt_printf(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'fprintf':      return { js: `__rt_fprintf(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'snprintf':     return { js: `__rt_snprintf(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'fputs':        return { js: `__rt_fputs(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'putchar':      return { js: `__rt_putchar(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'fwrite':       return { js: `__rt_fwrite(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'puts':         return { js: `__rt_puts(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'malloc':       return { js: `__rt_malloc(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'calloc':       return { js: `__rt_calloc(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'realloc':      return { js: `__rt_realloc(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'free':         return { js: `__rt_free(${argJs})`, type: { kind: 'base', name: 'void' } };
    case 'memcpy':       return { js: `__rt_memcpy(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'memmove':      return { js: `__rt_memmove(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'memset':       return { js: `__rt_memset(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'strlen':       return { js: `__rt_strlen(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'strchr':       return { js: `__rt_strchr(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'strcmp':       return { js: `__rt_strcmp(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'strcpy':       return { js: `__rt_strcpy(${argJs})`, type: { kind: 'pointer', target: { kind: 'base', name: 'char' } } };
    case 'atoi':         return { js: `__rt_atoi(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'atof':         return { js: `__rt_atof(${argJs})`, type: { kind: 'base', name: 'double' } };
    case 'abort':        return { js: `__rt_abort()`, type: { kind: 'base', name: 'void' } };
    case 'exit':         return { js: `__rt_exit(${argJs})`, type: { kind: 'base', name: 'void' } };
    case 'isnan':        return { js: `Number.isNaN(${argJs})`, type: { kind: 'base', name: 'int' } };
    case 'isinf':        return { js: `(!Number.isFinite(${argJs}) && !Number.isNaN(${argJs}))`, type: { kind: 'base', name: 'int' } };
    case 'fabs':         return { js: `Math.abs(${argJs})`, type: { kind: 'base', name: 'double' } };
    case 'floor':        return { js: `Math.floor(${argJs})`, type: { kind: 'base', name: 'double' } };
    case 'ceil':         return { js: `Math.ceil(${argJs})`, type: { kind: 'base', name: 'double' } };
    case 'sqrt':         return { js: `Math.sqrt(${argJs})`, type: { kind: 'base', name: 'double' } };
  }
  return { js: `/*?${name}*/`, type: null };
}

export { generate };
