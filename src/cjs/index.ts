/**
 * Vendored c2js translator. Adapted from the standalone `ctojs` project:
 * takes a C source string (the same flavor mtoc2's codegen produces) and
 * emits an executable JavaScript module string.
 *
 * Used by `src/cli.ts`'s `run --js` / `eval --js` path: instead of
 * compiling the translated C with `cc` and running the native binary, we
 * push it through this pipeline and run the resulting JS in the parent
 * Node process. Pure text in, pure text out — no filesystem or process
 * spawning.
 */

import { tokenize, stripComments } from "./lexer.js";
import { preprocess } from "./preprocessor.js";
import { parse } from "./parser.js";
import { generate } from "./codegen.js";
import { RUNTIME } from "./runtime.js";

/** Translate a C source string to a self-contained JS source string.
 *
 *  Mirrors the pipeline in the standalone `c2js` CLI: splice
 *  `\<newline>` continuations, strip comments, run the preprocessor,
 *  tokenize, parse, codegen the function bodies, and prepend the
 *  runtime preamble.
 *
 *  The result is a standalone `.js` file that, when evaluated by Node,
 *  runs the program. */
export function translateCToJs(cSource: string, filename = "<input>"): string {
  const spliced = cSource.replace(/\\\r?\n/g, "");
  const noComments = stripComments(spliced);
  const preprocessed = preprocess(noComments);
  const tokens = tokenize(preprocessed, filename);
  const ast = parse(tokens, filename);
  const body = generate(ast);
  return `'use strict';\n${RUNTIME}\n\n${body}\n`;
}
