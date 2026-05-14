/**
 * Class-definition registry. Walks the program once at lowering
 * entry, validates each `Stmt.ClassDef`, infers property types from
 * the declared default expressions, and stores the result keyed by
 * class name.
 *
 * Scope for v1:
 *   - Single `classdef Foo properties ... methods ... end end`
 *     blocks; no class attributes accepted.
 *   - No inheritance (`< Parent`), no handle classes, no
 *     `Events`/`Enumeration`/`Arguments` blocks, no operator
 *     overloads, no `get.`/`set.` accessors. Every rejected form
 *     surfaces with a clean `UnsupportedConstruct` carrying the
 *     class's source span.
 *   - Properties must declare a default-value expression. The
 *     default's type drives the property's storage type (after
 *     the precise default's type — the C typedef hash uses
 *     `cFieldTypeStr` (one C-type string per property), so the
 *     typedef stays stable even if writes evolve the internal type).
 *   - Methods can be the constructor (named same as class, returns
 *     the receiver) or regular methods. v1 only supports methods
 *     with 0 or 1 outputs (same as user functions).
 */
import type { Span, Stmt, Expr } from "../parser/index.js";
import { UnaryOperation } from "../parser/index.js";
import { UnsupportedConstruct, TypeError } from "./errors.js";
import {
  type Type,
  type ClassType,
  classType,
  scalarDouble,
  signFromNumber,
  tensorDouble,
} from "./types.js";

type ClassDefStmt = Extract<Stmt, { type: "ClassDef" }>;
type FuncStmt = Extract<Stmt, { type: "Function" }>;

export interface ClassRegistration {
  /** Source-level name. */
  className: string;
  /** Inferred class instance type. Property list is sorted (canonical
   *  form). Each property carries its default expression's precise
   *  type (with sign / exact / shape preserved) — the C typedef is
   *  independent of that precision (it hashes via `cFieldTypeStr`),
   *  so carrying the precise type is free at the C level and
   *  beneficial at the lattice level. */
  ty: ClassType;
  /** Property-default expressions, indexed by name. Kept around so
   *  the constructor-call site can synthesize an initial receiver as
   *  a `StructLit` whose field values are the default expressions. */
  defaults: Map<string, Expr>;
  /** Constructor (a method whose name matches the class). May be
   *  null when the class has no constructor — in that case the
   *  default-valued receiver is the constructor's "body" and
   *  `Foo()` (no args) is the only legal call. */
  constructor: FuncStmt | null;
  /** Other methods, keyed by source name. The constructor is NOT
   *  included here. */
  methods: Map<string, FuncStmt>;
}

export function collectClassDefs(
  stmts: ReadonlyArray<Stmt>
): Map<string, ClassRegistration> {
  const out = new Map<string, ClassRegistration>();
  for (const s of stmts) {
    if (s.type !== "ClassDef") continue;
    if (out.has(s.name)) {
      throw new UnsupportedConstruct(`duplicate classdef '${s.name}'`, s.span);
    }
    out.set(s.name, registerClassDef(s));
  }
  return out;
}

function registerClassDef(s: ClassDefStmt): ClassRegistration {
  if (s.classAttributes.length > 0) {
    throw new UnsupportedConstruct(
      `classdef '${s.name}' has class attributes; not supported in v1`,
      s.span
    );
  }
  if (s.superClass !== null) {
    throw new UnsupportedConstruct(
      `classdef '${s.name}' has a superclass; inheritance is not supported in v1`,
      s.span
    );
  }

  const props: { name: string; ty: Type }[] = [];
  const defaults = new Map<string, Expr>();
  const methods = new Map<string, FuncStmt>();
  let constructor: FuncStmt | null = null;

  for (const m of s.members) {
    switch (m.type) {
      case "Properties": {
        if (m.attributes.length > 0) {
          throw new UnsupportedConstruct(
            `'properties' block attributes are not supported in v1`,
            s.span
          );
        }
        for (let i = 0; i < m.names.length; i++) {
          const name = m.names[i];
          const def = m.defaultValues[i];
          if (def === null) {
            throw new UnsupportedConstruct(
              `property '${name}' on class '${s.name}' must have a ` +
                `default-value expression (v1 derives the property type from it)`,
              s.span
            );
          }
          // Carry the default's precise type (sign, exact, shape) on
          // the property. The C typedef hash uses `cFieldTypeStr` so
          // precision differences across writes don't shard typedefs,
          // but downstream reads / spec keying benefit from precision.
          const ty = inferDefaultType(def, name);
          if (props.some(p => p.name === name)) {
            throw new UnsupportedConstruct(
              `duplicate property '${name}' on class '${s.name}'`,
              s.span
            );
          }
          props.push({ name, ty });
          defaults.set(name, def);
        }
        break;
      }
      case "Methods": {
        if (m.attributes.length > 0) {
          throw new UnsupportedConstruct(
            `'methods' block attributes are not supported in v1`,
            s.span
          );
        }
        if (m.signatures && m.signatures.length > 0) {
          throw new UnsupportedConstruct(
            `external method declarations are not supported in v1`,
            s.span
          );
        }
        for (const stmt of m.body) {
          if (stmt.type !== "Function") {
            throw new UnsupportedConstruct(
              `non-Function statement inside 'methods' block`,
              stmt.span
            );
          }
          if (stmt.name.startsWith("get.") || stmt.name.startsWith("set.")) {
            throw new UnsupportedConstruct(
              `get/set accessor methods are not supported in v1`,
              stmt.span
            );
          }
          if (stmt.outputs.length > 1) {
            throw new UnsupportedConstruct(
              `method '${stmt.name}': only 0 or 1 outputs supported`,
              stmt.span
            );
          }
          if (stmt.name === s.name) {
            if (constructor !== null) {
              throw new UnsupportedConstruct(
                `duplicate constructor '${stmt.name}' on class '${s.name}'`,
                stmt.span
              );
            }
            if (stmt.outputs.length !== 1) {
              throw new UnsupportedConstruct(
                `constructor '${stmt.name}' must declare exactly one output (the receiver)`,
                stmt.span
              );
            }
            constructor = stmt;
          } else {
            if (methods.has(stmt.name)) {
              throw new UnsupportedConstruct(
                `duplicate method '${stmt.name}' on class '${s.name}'`,
                stmt.span
              );
            }
            methods.set(stmt.name, stmt);
          }
        }
        break;
      }
      case "Events":
      case "Enumeration":
      case "Arguments":
        throw new UnsupportedConstruct(
          `'${m.type}' blocks are not supported in v1`,
          s.span
        );
    }
  }

  return {
    className: s.name,
    ty: classType(s.name, props),
    defaults,
    constructor,
    methods,
  };
}

/** Shallow type inference for a property default-value expression.
 *  Accepts numeric literals, signed numeric literals, and tensor
 *  literals whose cells are all numeric. Anything richer (function
 *  call, identifier, etc.) is rejected — v1 requires defaults that
 *  the registry can type without running the full lowerer. */
function inferDefaultType(e: Expr, propName: string): Type {
  const span: Span = e.span;
  switch (e.type) {
    case "Number": {
      const v = Number(e.value);
      if (!Number.isFinite(v)) {
        throw new UnsupportedConstruct(
          `property '${propName}': default value '${e.value}' is non-finite`,
          span
        );
      }
      return scalarDouble(signFromNumber(v), v);
    }
    case "Unary": {
      // Accept unary +/- on a numeric literal.
      const inner = inferDefaultType(e.operand, propName);
      if (inner.kind !== "Numeric" || typeof inner.exact !== "number") {
        throw new UnsupportedConstruct(
          `property '${propName}': default must be a numeric literal (or its negation)`,
          span
        );
      }
      if (e.op === UnaryOperation.Plus) return inner;
      if (e.op === UnaryOperation.Minus) {
        const v = -inner.exact;
        return scalarDouble(signFromNumber(v), v);
      }
      throw new UnsupportedConstruct(
        `property '${propName}': unsupported unary op in default`,
        span
      );
    }
    case "Tensor": {
      // Empty `[]` → 0×0 tensor.
      if (e.rows.length === 0) {
        return tensorDouble([0, 0]);
      }
      const rows = e.rows.length;
      const cols = e.rows[0].length;
      for (const r of e.rows) {
        if (r.length !== cols) {
          throw new UnsupportedConstruct(
            `property '${propName}': tensor default has ragged rows`,
            span
          );
        }
      }
      // Verify every cell is a numeric literal (or +/-numeric).
      const data = new Float64Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cellTy = inferDefaultType(e.rows[r][c], propName);
          if (cellTy.kind !== "Numeric" || typeof cellTy.exact !== "number") {
            throw new TypeError(
              `property '${propName}': tensor default cell must be a numeric literal`,
              span
            );
          }
          data[c * rows + r] = cellTy.exact;
        }
      }
      // 1×1 collapses to scalar (matches MATLAB).
      if (rows === 1 && cols === 1) {
        return scalarDouble(signFromNumber(data[0]), data[0]);
      }
      return tensorDouble([rows, cols], data);
    }
    default:
      throw new UnsupportedConstruct(
        `property '${propName}': default must be a literal numeric or tensor ` +
          `(got '${e.type}')`,
        span
      );
  }
}
