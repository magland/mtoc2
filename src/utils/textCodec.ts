/** Module-level TextEncoder/TextDecoder singletons shared across the
 *  hooks, db, and UI layers. Instantiating one per module wasn't a
 *  correctness problem — both classes are stateless — but consolidating
 *  removes the repetition and clarifies that all encodings use the
 *  default UTF-8. */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder("utf-8");
