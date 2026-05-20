/**
 * Thin re-export of numbl's parser. mtoc2 lives as a sibling of numbl
 * during development and imports parser/lexer/AST shape directly from
 * `../../../numbl/src/numbl-core/parser`. Structural AST drift is
 * caught at `tsc` time.
 *
 * The pinned numbl SHA lives in `NUMBL_VERSION`. CI checks out numbl
 * at exactly that SHA so its `cross-runner` job runs against a known-
 * validated upstream. Local dev may use a different sibling checkout,
 * but `tsc` only catches structural breakage — semantic drift (e.g.
 * resolver precedence) won't surface until the cross-runner is run
 * locally.
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
