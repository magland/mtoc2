// JS sibling of `tensor_norm.h`. Real vector 2-norm. Complex
// variant lands when the JS complex runtime arrives.

export function mtoc2_norm2_real(a) {
  let acc = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i];
    acc += x * x;
  }
  return Math.sqrt(acc);
}
