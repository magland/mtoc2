'use strict';

// Recursive-descent parser for a subset of C.
// Produces an AST consumed by codegen.js.

const BASE_TYPE_KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double',
  'signed', 'unsigned', '_Bool', 'size_t',
  // `_Complex` is accepted as a type-spec part so mtoc2's emitted runtime
  // (which includes complex helpers transitively) parses cleanly. The
  // name resolver below collapses to `double` whenever `double` appears
  // in the parts list, so `double _Complex` becomes the JS-side `double`.
  // Code that actually exercises complex arithmetic will produce wrong
  // results under --js, but unreferenced helpers stay parseable.
  '_Complex',
]);

const PREDEFINED_TYPEDEFS = new Set([
  'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
]);

function parse(tokens, filename = '<input>') {
  const state = {
    tokens, i: 0, filename,
    typedefs: new Set(PREDEFINED_TYPEDEFS),
    structTags: new Set(),
    enumValues: new Map(), // name -> numeric value
  };
  return parseProgram(state);
}

function err(state, msg, tok) {
  const t = tok || peek(state);
  throw new Error(`${state.filename}:${t.line}:${t.col}: ${msg} (got ${t.type}${t.value !== null ? ' '+JSON.stringify(t.value) : ''})`);
}

function peek(state, k = 0) { return state.tokens[state.i + k]; }
function advance(state) { return state.tokens[state.i++]; }
function match(state, type, value) {
  const t = peek(state);
  if (t.type === type && (value === undefined || t.value === value)) { state.i++; return t; }
  return null;
}
function expect(state, type, value) {
  const t = peek(state);
  if (t.type !== type || (value !== undefined && t.value !== value)) {
    err(state, `expected ${type}${value !== undefined ? ' '+JSON.stringify(value) : ''}`);
  }
  state.i++;
  return t;
}

function parseProgram(state) {
  const decls = [];
  while (peek(state).type !== 'eof') {
    const d = parseTopLevel(state);
    if (Array.isArray(d)) decls.push(...d); else if (d) decls.push(d);
  }
  return { kind: 'Program', decls };
}

function parseTopLevel(state) {
  // Possible: typedef, struct decl, enum decl, function def, var decl
  if (match(state, 'kw', 'typedef')) return parseTypedef(state);

  // Skip storage class specifiers: static, extern, inline
  const storage = [];
  while (peek(state).type === 'kw' && ['static','extern','inline','register','auto'].includes(peek(state).value)) {
    storage.push(advance(state).value);
  }

  // It's a struct/enum-only decl?
  if (peek(state).type === 'kw' && peek(state).value === 'enum') {
    // could be either an enum-only declaration or a typed variable starting with enum tag
    const saved = state.i;
    const e = parseEnum(state);
    if (match(state, 'punct', ';')) return e;
    // not a standalone enum decl; fall back to var/func decl
    state.i = saved;
  }

  if (peek(state).type === 'kw' && (peek(state).value === 'struct' || peek(state).value === 'union')) {
    const saved = state.i;
    advance(state); // struct/union
    const tagTok = match(state, 'id');
    if (match(state, 'punct', '{')) {
      // struct definition
      const fields = parseStructFields(state);
      expect(state, 'punct', '}');
      if (tagTok) state.structTags.add(tagTok.value);
      if (match(state, 'punct', ';')) {
        return { kind: 'StructDecl', tag: tagTok ? tagTok.value : null, fields };
      }
      // struct used as a type in a declaration; reset and reparse
      state.i = saved;
    } else {
      state.i = saved;
    }
  }

  // Type + name [ '(' params ')' { body } | ... ]
  const type = parseTypeRef(state);
  const declarators = [];
  do {
    declarators.push(parseDeclarator(state, type));
  } while (false); // we'll handle multiple declarators after fork

  const first = declarators[0];

  // function definition: name '(' params ')' '{' body '}'
  if (first && first.kind === 'function') {
    // does a body follow?
    if (peek(state).type === 'punct' && peek(state).value === '{') {
      const body = parseBlock(state);
      return { kind: 'FuncDecl', name: first.name, returnType: first.returnType,
               params: first.params, body, storage };
    } else {
      expect(state, 'punct', ';');
      return { kind: 'FuncProto', name: first.name, returnType: first.returnType,
               params: first.params, storage };
    }
  }

  // var decl, possibly more comma-separated
  while (match(state, 'punct', ',')) {
    declarators.push(parseDeclarator(state, type));
  }
  expect(state, 'punct', ';');

  return declarators.map(d => ({
    kind: 'VarDecl', name: d.name, type: d.type, init: d.init, arraySize: d.arraySize, storage,
  }));
}

function parseTypedef(state) {
  // typedef <type> <name> [, <name>...] ;
  // typedef struct { ... } name; — common in the corpus
  // typedef RET (*NAME)(PARAMS); — function pointer
  const type = parseTypeRef(state, /*allowAnonStruct*/ true);

  // Function-pointer form: `typedef RET (*NAME)(PARAMS);` (or variants
  // with extra pointer stars on RET). We only need to register NAME so
  // later uses of NAME parse as a type; we don't generate any JS for it.
  if (peek(state).type === 'punct' && peek(state).value === '(') {
    const saved = state.i;
    state.i++;
    // Skip pointer stars and qualifiers
    while (match(state, 'op', '*')
        || (peek(state).type === 'kw' && ['const','volatile','restrict','__restrict__','__restrict'].includes(peek(state).value) && advance(state))) {}
    if (peek(state).type === 'id') {
      const nameTok = advance(state);
      if (match(state, 'punct', ')')) {
        // expect `(params)` next
        if (match(state, 'punct', '(')) {
          // skip params (balanced parens)
          let depth = 1;
          while (depth > 0 && peek(state).type !== 'eof') {
            const tk = advance(state);
            if (tk.type === 'punct' && tk.value === '(') depth++;
            else if (tk.type === 'punct' && tk.value === ')') depth--;
          }
          expect(state, 'punct', ';');
          state.typedefs.add(nameTok.value);
          return { kind: 'TypedefDecl', defs: [{ name: nameTok.value, type: { kind: 'fnptr' } }], baseType: type };
        }
      }
    }
    // Not a function pointer typedef after all; rewind.
    state.i = saved;
  }

  const names = [];
  do {
    const declType = parsePointerLayer(state, type);
    const nameTok = expect(state, 'id');
    names.push({ name: nameTok.value, type: declType });
    state.typedefs.add(nameTok.value);
  } while (match(state, 'punct', ','));
  expect(state, 'punct', ';');
  return { kind: 'TypedefDecl', defs: names, baseType: type };
}

function parseStructFields(state) {
  const fields = [];
  while (peek(state).type !== 'punct' || peek(state).value !== '}') {
    const fieldType = parseTypeRef(state);
    do {
      const declType = parsePointerLayer(state, fieldType);
      const nameTok = expect(state, 'id');
      let arraySize = null;
      let t = declType;
      while (match(state, 'punct', '[')) {
        let sz = null;
        if (!(peek(state).type === 'punct' && peek(state).value === ']')) {
          sz = parseExpr(state);
        }
        expect(state, 'punct', ']');
        t = { kind: 'array', element: t, size: sz };
        if (arraySize === null) arraySize = sz;
      }
      fields.push({ name: nameTok.value, type: t, arraySize });
    } while (match(state, 'punct', ','));
    expect(state, 'punct', ';');
  }
  return fields;
}

function parseEnum(state) {
  expect(state, 'kw', 'enum');
  const tagTok = match(state, 'id');
  let members = null;
  if (match(state, 'punct', '{')) {
    members = [];
    let nextValue = 0;
    while (peek(state).type !== 'punct' || peek(state).value !== '}') {
      const nameTok = expect(state, 'id');
      let value = nextValue;
      if (match(state, 'op', '=')) {
        const e = parseAssignExpr(state);
        const v = evalConstExpr(e, state.enumValues);
        value = v;
      }
      members.push({ name: nameTok.value, value });
      state.enumValues.set(nameTok.value, value);
      nextValue = value + 1;
      if (!match(state, 'punct', ',')) break;
    }
    expect(state, 'punct', '}');
  }
  return { kind: 'EnumDecl', tag: tagTok ? tagTok.value : null, members };
}

function evalConstExpr(e, env) {
  if (e.kind === 'Num') return e.value;
  if (e.kind === 'Ident' && env.has(e.name)) return env.get(e.name);
  if (e.kind === 'Binary') {
    const a = evalConstExpr(e.left, env);
    const b = evalConstExpr(e.right, env);
    switch (e.op) {
      case '+': return a + b; case '-': return a - b;
      case '*': return a * b; case '/': return Math.trunc(a / b);
      case '<<': return a << b; case '>>': return a >> b;
      case '|': return a | b; case '&': return a & b; case '^': return a ^ b;
    }
  }
  if (e.kind === 'Unary' && e.op === '-') return -evalConstExpr(e.operand, env);
  throw new Error(`cannot evaluate constant expression`);
}

function isTypeStart(state) {
  const t = peek(state);
  if (t.type === 'kw') {
    if (BASE_TYPE_KEYWORDS.has(t.value)) return true;
    if (t.value === 'struct' || t.value === 'enum' || t.value === 'union') return true;
    if (t.value === 'const' || t.value === 'volatile' || t.value === 'restrict'
        || t.value === '__restrict__' || t.value === '__restrict') return true;
  }
  if (t.type === 'id' && state.typedefs.has(t.value)) return true;
  return false;
}

function parseTypeRef(state, allowAnonStruct = false) {
  // qualifiers + base type
  const qualifiers = [];
  while (peek(state).type === 'kw' && ['const','volatile','restrict','__restrict__','__restrict'].includes(peek(state).value)) {
    qualifiers.push(advance(state).value);
  }

  let type;
  const t = peek(state);

  if (t.type === 'kw' && (t.value === 'struct' || t.value === 'union')) {
    // Treat `union` like `struct` — fields just become properties on a JS
    // object. C unions overlap in memory; we don't model that. As long as
    // each accessed field is the most recently written one (which is how
    // example code uses union { d; t; tensor; } tagged with `kind`), this
    // produces correct behavior.
    advance(state);
    const tagTok = match(state, 'id');
    if (match(state, 'punct', '{')) {
      const fields = parseStructFields(state);
      expect(state, 'punct', '}');
      type = { kind: 'struct', tag: tagTok ? tagTok.value : null, fields };
    } else {
      type = { kind: 'struct', tag: tagTok ? tagTok.value : null, fields: null };
    }
  } else if (t.type === 'kw' && t.value === 'enum') {
    advance(state);
    const tagTok = match(state, 'id');
    if (match(state, 'punct', '{')) {
      // skip the enum body for typing purposes; we only care about it for evaluation in enum decls
      // — but record values into state.enumValues for use as constants
      let nextValue = 0;
      while (peek(state).type !== 'punct' || peek(state).value !== '}') {
        const nameTok = expect(state, 'id');
        let value = nextValue;
        if (match(state, 'op', '=')) {
          const e = parseAssignExpr(state);
          value = evalConstExpr(e, state.enumValues);
        }
        state.enumValues.set(nameTok.value, value);
        nextValue = value + 1;
        if (!match(state, 'punct', ',')) break;
      }
      expect(state, 'punct', '}');
    }
    type = { kind: 'base', name: 'int', qualifiers: [] };
  } else if (t.type === 'kw' && BASE_TYPE_KEYWORDS.has(t.value)) {
    const parts = [];
    while (peek(state).type === 'kw' && BASE_TYPE_KEYWORDS.has(peek(state).value)) {
      parts.push(advance(state).value);
    }
    let name;
    if (parts.includes('double')) name = 'double';
    else if (parts.includes('float')) name = 'float';
    else if (parts.includes('char')) name = 'char';
    else if (parts.includes('void')) name = 'void';
    else if (parts.includes('_Bool')) name = 'bool';
    else name = 'int'; // covers short/int/long/long long/signed/unsigned
    type = { kind: 'base', name, qualifiers, parts };
  } else if (t.type === 'id' && state.typedefs.has(t.value)) {
    advance(state);
    type = { kind: 'named', name: t.value, qualifiers };
  } else {
    err(state, 'expected type');
  }

  // trailing qualifiers (const after type)
  while (peek(state).type === 'kw' && ['const','volatile','restrict','__restrict__','__restrict'].includes(peek(state).value)) {
    qualifiers.push(advance(state).value);
  }
  type.qualifiers = qualifiers;
  return type;
}

function parsePointerLayer(state, baseType) {
  let t = baseType;
  while (match(state, 'op', '*')) {
    const ptrQuals = [];
    while (peek(state).type === 'kw' && ['const','volatile','restrict','__restrict__','__restrict'].includes(peek(state).value)) {
      ptrQuals.push(advance(state).value);
    }
    t = { kind: 'pointer', target: t, qualifiers: ptrQuals };
  }
  return t;
}

function parseDeclarator(state, baseType) {
  // Returns either { kind: 'function', returnType, name, params } for fn,
  // or { kind: 'variable', type, name, init?, arraySize? } for var.
  const declType = parsePointerLayer(state, baseType);
  const nameTok = expect(state, 'id');

  // function?
  if (peek(state).type === 'punct' && peek(state).value === '(') {
    advance(state);
    const params = [];
    if (!(peek(state).type === 'punct' && peek(state).value === ')')) {
      // possibly "void" alone meaning no params
      if (peek(state).type === 'kw' && peek(state).value === 'void'
          && peek(state, 1).type === 'punct' && peek(state, 1).value === ')') {
        advance(state);
      } else {
        do {
          const pType = parseTypeRef(state);
          const pDeclType = parsePointerLayer(state, pType);
          // The name is optional in prototypes; in our usage it's always present
          let pName = null;
          if (peek(state).type === 'id') pName = advance(state).value;
          // Array parameter T name[N] decays to pointer; just record as pointer
          let pTypeFinal = pDeclType;
          while (match(state, 'punct', '[')) {
            if (!(peek(state).type === 'punct' && peek(state).value === ']')) parseExpr(state);
            expect(state, 'punct', ']');
            pTypeFinal = { kind: 'pointer', target: pTypeFinal };
          }
          params.push({ name: pName, type: pTypeFinal });
        } while (match(state, 'punct', ','));
      }
    }
    expect(state, 'punct', ')');
    return { kind: 'function', name: nameTok.value, returnType: declType, params };
  }

  // variable; optionally array
  let t = declType;
  let arraySize = null;
  while (match(state, 'punct', '[')) {
    let sz = null;
    if (!(peek(state).type === 'punct' && peek(state).value === ']')) {
      sz = parseAssignExpr(state);
    }
    expect(state, 'punct', ']');
    t = { kind: 'array', element: t, size: sz };
    if (arraySize === null) arraySize = sz;
  }

  let init = null;
  if (match(state, 'op', '=')) {
    init = parseInitializer(state);
  }

  return { kind: 'variable', name: nameTok.value, type: t, init, arraySize };
}

function parseInitializer(state) {
  if (match(state, 'punct', '{')) {
    const elems = [];
    if (!(peek(state).type === 'punct' && peek(state).value === '}')) {
      do {
        // Trailing comma support: {a, b, }
        if (peek(state).type === 'punct' && peek(state).value === '}') break;
        // Designated initializer: .field = value  or  [idx] = value
        if (peek(state).type === 'op' && peek(state).value === '.') {
          advance(state);
          const nameTok = expect(state, 'id');
          expect(state, 'op', '=');
          const value = parseInitializer(state);
          elems.push({ kind: 'Designator', name: nameTok.value, value });
          continue;
        }
        if (peek(state).type === 'punct' && peek(state).value === '[') {
          advance(state);
          const idx = parseAssignExpr(state);
          expect(state, 'punct', ']');
          expect(state, 'op', '=');
          const value = parseInitializer(state);
          elems.push({ kind: 'Designator', index: idx, value });
          continue;
        }
        elems.push(parseInitializer(state));
      } while (match(state, 'punct', ','));
    }
    expect(state, 'punct', '}');
    return { kind: 'InitList', elems };
  }
  return parseAssignExpr(state);
}

function parseBlock(state) {
  expect(state, 'punct', '{');
  const stmts = [];
  while (peek(state).type !== 'punct' || peek(state).value !== '}') {
    const s = parseStmt(state);
    if (Array.isArray(s)) stmts.push(...s); else if (s) stmts.push(s);
  }
  expect(state, 'punct', '}');
  return { kind: 'Block', stmts };
}

function parseStmt(state) {
  const t = peek(state);
  if (t.type === 'punct' && t.value === '{') return parseBlock(state);
  if (t.type === 'punct' && t.value === ';') { advance(state); return { kind: 'EmptyStmt' }; }
  if (t.type === 'kw') {
    switch (t.value) {
      case 'if': return parseIfStmt(state);
      case 'for': return parseForStmt(state);
      case 'while': return parseWhileStmt(state);
      case 'do': return parseDoWhileStmt(state);
      case 'return': return parseReturnStmt(state);
      case 'break': advance(state); expect(state, 'punct', ';'); return { kind: 'Break' };
      case 'continue': advance(state); expect(state, 'punct', ';'); return { kind: 'Continue' };
      case 'goto':
        // Defense-in-depth: mtoc2's emit no longer produces `goto`
        // (early-return cleanup is inlined at each ReturnFromFunction
        // site instead of jumping to a shared tail label). Throw with
        // a clean message rather than letting parseExpr surface
        // `expected primary expression (got kw "goto")` if a future
        // emit-site regresses or someone routes hand-written C through
        // c2js. JS has labeled `break`/`continue` but no `goto`, so
        // there's no clean translation path.
        throw new Error(
          `${state.filename}:${t.line}:${t.col}: c2js: 'goto' is not ` +
          `supported. JS has no goto; restructure the C source to use ` +
          `early-return with inline cleanup, or wrap forward jumps in a ` +
          `do { ... } while (0) block with break.`
        );
      case 'switch': return parseSwitchStmt(state);
      case 'typedef': return parseTypedef(state);
      case 'enum': {
        // enum decl as a statement (e.g., `enum { CELL_CAP = 32 };`)
        const saved = state.i;
        const e = parseEnum(state);
        if (match(state, 'punct', ';')) return e;
        state.i = saved;
        break;
      }
    }
  }

  // skip storage classes for local decls
  if (t.type === 'kw' && (t.value === 'static' || t.value === 'register' || t.value === 'auto' || t.value === 'extern')) {
    advance(state);
  }

  if (isTypeStart(state)) {
    // var decl
    const type = parseTypeRef(state);
    const declarators = [];
    do {
      declarators.push(parseDeclarator(state, type));
    } while (match(state, 'punct', ','));
    expect(state, 'punct', ';');
    return declarators.map(d => ({
      kind: 'VarDecl', name: d.name, type: d.type, init: d.init, arraySize: d.arraySize,
    }));
  }

  const e = parseExpr(state);
  expect(state, 'punct', ';');
  return { kind: 'ExprStmt', expr: e };
}

function parseIfStmt(state) {
  expect(state, 'kw', 'if');
  expect(state, 'punct', '(');
  const cond = parseExpr(state);
  expect(state, 'punct', ')');
  const then = parseStmt(state);
  let elseBranch = null;
  if (match(state, 'kw', 'else')) elseBranch = parseStmt(state);
  return { kind: 'If', cond, then, else: elseBranch };
}

function parseForStmt(state) {
  expect(state, 'kw', 'for');
  expect(state, 'punct', '(');
  let init = null;
  if (!(peek(state).type === 'punct' && peek(state).value === ';')) {
    if (isTypeStart(state)) {
      const type = parseTypeRef(state);
      const declarators = [];
      do {
        declarators.push(parseDeclarator(state, type));
      } while (match(state, 'punct', ','));
      init = declarators.map(d => ({
        kind: 'VarDecl', name: d.name, type: d.type, init: d.init, arraySize: d.arraySize,
      }));
    } else {
      init = parseExpr(state);
    }
  }
  expect(state, 'punct', ';');
  let cond = null;
  if (!(peek(state).type === 'punct' && peek(state).value === ';')) cond = parseExpr(state);
  expect(state, 'punct', ';');
  let step = null;
  if (!(peek(state).type === 'punct' && peek(state).value === ')')) step = parseExpr(state);
  expect(state, 'punct', ')');
  const body = parseStmt(state);
  return { kind: 'For', init, cond, step, body };
}

function parseWhileStmt(state) {
  expect(state, 'kw', 'while');
  expect(state, 'punct', '(');
  const cond = parseExpr(state);
  expect(state, 'punct', ')');
  const body = parseStmt(state);
  return { kind: 'While', cond, body };
}

function parseDoWhileStmt(state) {
  expect(state, 'kw', 'do');
  const body = parseStmt(state);
  expect(state, 'kw', 'while');
  expect(state, 'punct', '(');
  const cond = parseExpr(state);
  expect(state, 'punct', ')');
  expect(state, 'punct', ';');
  return { kind: 'DoWhile', body, cond };
}

function parseSwitchStmt(state) {
  expect(state, 'kw', 'switch');
  expect(state, 'punct', '(');
  const disc = parseExpr(state);
  expect(state, 'punct', ')');
  expect(state, 'punct', '{');
  const cases = [];
  let current = null;
  while (peek(state).type !== 'punct' || peek(state).value !== '}') {
    if (match(state, 'kw', 'case')) {
      const val = parseExpr(state);
      expect(state, 'punct', ':');
      current = { value: val, stmts: [] };
      cases.push(current);
      continue;
    }
    if (match(state, 'kw', 'default')) {
      expect(state, 'punct', ':');
      current = { value: null, stmts: [] };
      cases.push(current);
      continue;
    }
    if (!current) current = { value: null, stmts: [] }, cases.push(current);
    current.stmts.push(parseStmt(state));
  }
  expect(state, 'punct', '}');
  return { kind: 'Switch', disc, cases };
}

function parseReturnStmt(state) {
  expect(state, 'kw', 'return');
  let value = null;
  if (!(peek(state).type === 'punct' && peek(state).value === ';')) {
    value = parseExpr(state);
  }
  expect(state, 'punct', ';');
  return { kind: 'Return', value };
}

// ------ Expressions ------

function parseExpr(state) {
  let e = parseAssignExpr(state);
  while (match(state, 'punct', ',')) {
    const right = parseAssignExpr(state);
    e = { kind: 'Comma', left: e, right };
  }
  return e;
}

const ASSIGN_OPS = new Set(['=','+=','-=','*=','/=','%=','&=','|=','^=','<<=','>>=']);

function parseAssignExpr(state) {
  const lhs = parseCondExpr(state);
  const t = peek(state);
  if (t.type === 'op' && ASSIGN_OPS.has(t.value)) {
    advance(state);
    const rhs = parseAssignExpr(state);
    return { kind: 'Assign', op: t.value, target: lhs, value: rhs };
  }
  return lhs;
}

function parseCondExpr(state) {
  const c = parseLogicalOr(state);
  if (match(state, 'punct', '?')) {
    const then = parseExpr(state);
    expect(state, 'punct', ':');
    const elseE = parseAssignExpr(state);
    return { kind: 'Cond', cond: c, then, else: elseE };
  }
  return c;
}

function parseBinaryLevel(state, opSet, next) {
  let left = next(state);
  while (true) {
    const t = peek(state);
    if (t.type === 'op' && opSet.has(t.value)) {
      const op = advance(state).value;
      const right = next(state);
      left = { kind: 'Binary', op, left, right };
    } else break;
  }
  return left;
}

const L_OR = new Set(['||']);
const L_AND = new Set(['&&']);
const B_OR = new Set(['|']);
const B_XOR = new Set(['^']);
const B_AND = new Set(['&']);
const EQ = new Set(['==','!=']);
const REL = new Set(['<','>','<=','>=']);
const SHIFT = new Set(['<<','>>']);
const ADD = new Set(['+','-']);
const MUL = new Set(['*','/','%']);

function parseLogicalOr(state)  { return parseBinaryLevel(state, L_OR,  parseLogicalAnd); }
function parseLogicalAnd(state) { return parseBinaryLevel(state, L_AND, parseBitOr); }
function parseBitOr(state)      { return parseBinaryLevel(state, B_OR,  parseBitXor); }
function parseBitXor(state)     { return parseBinaryLevel(state, B_XOR, parseBitAnd); }
function parseBitAnd(state)     { return parseBinaryLevel(state, B_AND, parseEqRel); }
function parseEqRel(state)      { return parseBinaryLevel(state, EQ,    parseRelational); }
function parseRelational(state) { return parseBinaryLevel(state, REL,   parseShift); }
function parseShift(state)      { return parseBinaryLevel(state, SHIFT, parseAdditive); }
function parseAdditive(state)   { return parseBinaryLevel(state, ADD,   parseMultiplicative); }
function parseMultiplicative(state) { return parseBinaryLevel(state, MUL, parseCastUnary); }

function parseCastUnary(state) {
  // possible cast: ( typeName ) castUnary
  if (peek(state).type === 'punct' && peek(state).value === '(') {
    if (isCastNext(state)) {
      advance(state); // (
      const type = parseTypeName(state);
      expect(state, 'punct', ')');
      // could also be a compound literal: (type){...}
      if (peek(state).type === 'punct' && peek(state).value === '{') {
        const init = parseInitializer(state);
        return { kind: 'CompoundLit', type, init };
      }
      const expr = parseCastUnary(state);
      return { kind: 'Cast', type, expr };
    }
  }
  return parseUnary(state);
}

function isCastNext(state) {
  // peek past '(' and decide if it starts a type name
  let k = 1;
  const t = state.tokens[state.i + k];
  if (!t) return false;
  if (t.type === 'kw') {
    if (BASE_TYPE_KEYWORDS.has(t.value)) return true;
    if (t.value === 'struct' || t.value === 'enum' || t.value === 'union') return true;
    if (t.value === 'const' || t.value === 'volatile' || t.value === 'restrict'
        || t.value === '__restrict__' || t.value === '__restrict') return true;
  }
  if (t.type === 'id' && state.typedefs.has(t.value)) return true;
  return false;
}

function parseTypeName(state) {
  // Same as parseTypeRef + pointer/array suffix, no identifier.
  let type = parseTypeRef(state);
  type = parsePointerLayer(state, type);
  // array suffix
  while (match(state, 'punct', '[')) {
    let sz = null;
    if (!(peek(state).type === 'punct' && peek(state).value === ']')) {
      sz = parseAssignExpr(state);
    }
    expect(state, 'punct', ']');
    type = { kind: 'array', element: type, size: sz };
  }
  return type;
}

function parseUnary(state) {
  const t = peek(state);
  if (t.type === 'op' && ['&','*','+','-','!','~','++','--'].includes(t.value)) {
    const op = advance(state).value;
    const operand = parseCastUnary(state);
    return { kind: 'Unary', op, operand, prefix: true };
  }
  if (t.type === 'kw' && t.value === 'sizeof') {
    advance(state);
    if (peek(state).type === 'punct' && peek(state).value === '(') {
      // could be sizeof(type) or sizeof(expr)
      if (isCastNext(state)) {
        advance(state);
        const type = parseTypeName(state);
        expect(state, 'punct', ')');
        return { kind: 'Sizeof', target: { kind: 'type', type } };
      }
      advance(state);
      const e = parseExpr(state);
      expect(state, 'punct', ')');
      return { kind: 'Sizeof', target: { kind: 'expr', expr: e } };
    }
    const e = parseUnary(state);
    return { kind: 'Sizeof', target: { kind: 'expr', expr: e } };
  }
  return parsePostfix(state);
}

function parsePostfix(state) {
  let e = parsePrimary(state);
  while (true) {
    const t = peek(state);
    if (t.type === 'punct' && t.value === '(') {
      advance(state);
      const args = [];
      if (!(peek(state).type === 'punct' && peek(state).value === ')')) {
        do { args.push(parseAssignExpr(state)); } while (match(state, 'punct', ','));
      }
      expect(state, 'punct', ')');
      e = { kind: 'Call', callee: e, args };
      continue;
    }
    if (t.type === 'punct' && t.value === '[') {
      advance(state);
      const idx = parseExpr(state);
      expect(state, 'punct', ']');
      e = { kind: 'Index', object: e, index: idx };
      continue;
    }
    if (t.type === 'op' && t.value === '.') {
      advance(state);
      const nameTok = expect(state, 'id');
      e = { kind: 'Member', object: e, prop: nameTok.value, arrow: false };
      continue;
    }
    if (t.type === 'op' && t.value === '->') {
      advance(state);
      const nameTok = expect(state, 'id');
      e = { kind: 'Member', object: e, prop: nameTok.value, arrow: true };
      continue;
    }
    if (t.type === 'op' && (t.value === '++' || t.value === '--')) {
      advance(state);
      e = { kind: 'Unary', op: t.value, operand: e, prefix: false };
      continue;
    }
    break;
  }
  return e;
}

function parsePrimary(state) {
  const t = peek(state);
  if (t.type === 'punct' && t.value === '(') {
    advance(state);
    // GCC statement expression: ({ stmts; final_expr; })
    if (peek(state).type === 'punct' && peek(state).value === '{') {
      const block = parseBlock(state);
      expect(state, 'punct', ')');
      return { kind: 'StmtExpr', block };
    }
    const e = parseExpr(state);
    expect(state, 'punct', ')');
    return e;
  }
  if (t.type === 'num') { advance(state); return { kind: 'Num', value: t.value, isFloat: t.isFloat }; }
  if (t.type === 'str') {
    // concatenate adjacent string literals
    let s = t.value; advance(state);
    while (peek(state).type === 'str') s += advance(state).value;
    return { kind: 'Str', value: s };
  }
  if (t.type === 'chr') { advance(state); return { kind: 'Chr', value: t.value }; }
  if (t.type === 'id') {
    advance(state);
    if (state.enumValues.has(t.value)) {
      return { kind: 'Num', value: state.enumValues.get(t.value), isFloat: false };
    }
    return { kind: 'Ident', name: t.value };
  }
  err(state, 'expected primary expression');
}

export { parse };
