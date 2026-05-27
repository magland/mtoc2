// JS sibling of `tensor_triangular.h`. Two helpers: `triu` keeps
// entries with `j - i >= k`, `tril` keeps entries with `i - j >= -k`;
// zero everywhere else. Mirrors `triPart` in numbl's
// `interpreter/builtins/array-extras.ts`.

import { mtoc2_tensor_alloc } from "../tensor/tensor_alloc.js";

export function mtoc2_tensor_triu(a, k) {
  const rows = a.shape[0];
  const cols = a.shape[1];
  const out = mtoc2_tensor_alloc(rows, cols);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      if (j - i >= k) {
        const idx = i + j * rows;
        out.data[idx] = a.data[idx];
      }
    }
  }
  return out;
}

export function mtoc2_tensor_tril(a, k) {
  const rows = a.shape[0];
  const cols = a.shape[1];
  const out = mtoc2_tensor_alloc(rows, cols);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      if (i - j >= -k) {
        const idx = i + j * rows;
        out.data[idx] = a.data[idx];
      }
    }
  }
  return out;
}
