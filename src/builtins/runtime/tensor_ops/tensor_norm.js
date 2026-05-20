// JS sibling of `tensor_norm.h`. Vector 2-norm for real and complex
// tensors. The complex variant tolerates a missing imag lane (real
// tensor flowing through a complex-typed norm route) by treating it
// as zero.

export function mtoc2_norm2_real(a) {
  let acc = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i];
    acc += x * x;
  }
  return Math.sqrt(acc);
}

export function mtoc2_norm2_complex(a) {
  let acc = 0;
  const im = a.imag;
  for (let i = 0; i < a.data.length; i++) {
    const re = a.data[i];
    const imv = im !== undefined ? im[i] : 0;
    acc += re * re + imv * imv;
  }
  return Math.sqrt(acc);
}
