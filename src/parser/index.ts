/**
 * Thin re-export of numbl's parser. mtoc2 lives as a sibling of numbl
 * during development and imports parser/lexer/AST shape directly from
 * `../../../numbl/src/numbl-core/parser`. Drift is caught at `tsc -b`
 * time.
 *
 * The pinned numbl SHA lives in `NUMBL_VERSION`; CI checks it against
 * sibling numbl's HEAD to flag upstream changes we haven't audited.
 */

export {
  parseMFile,
  SyntaxError,
  BinaryOperation,
  UnaryOperation,
} from "../../../numbl/src/numbl-core/parser/index.js";

export type {
  Span,
  Expr,
  Stmt,
  LValue,
  AbstractSyntaxTree,
} from "../../../numbl/src/numbl-core/parser/index.js";
