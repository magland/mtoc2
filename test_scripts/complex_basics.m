test_literals();
test_arithmetic();
test_division();
test_power();
test_unary_minus();
test_compare_eq_ne();
test_compare_rel();
test_if_cond();
test_while_cond();
test_through_func();
test_tensor_literals();
test_tensor_disp();
test_tensor_copy();
test_tensor_pass_to_func();
test_tensor_arith_tt();
test_tensor_arith_ts();
test_tensor_arith_st();
test_tensor_arith_bcast();
test_tensor_arith_mixed_real();

function test_literals()
  disp(1i);
  disp(2.5i);
  disp(0i);
  disp(1 + 0i);
  disp(0 + 1i);
  disp(1 + 2i);
  disp(3 - 4i);
end

function test_arithmetic()
  z = 1 + 2i;
  w = 3 - 4i;
  disp(z + w);
  disp(z - w);
  disp(w - z);
  disp(z * w);
  disp(z + 5);
  disp(5 - z);
  disp(2 * z);
  disp(z * 0);
  % Pure imaginary squared is real-negative.
  disp(2i * 2i);
end

function test_division()
  z = 1 + 2i;
  w = 3 + 4i;
  disp(z / w);
  disp(w / z);
  disp(z / 2);
  disp(2 / w);
end

function test_power()
  % Skip (1+1i)^2: the real-part artifact differs in tiny ulps between
  % JS's exp/log/sin/cos chain (numbl) and C's cpow (mtoc2). Both are
  % mathematically `0 + 2i`; both renderers show a tiny real residue
  % at different magnitudes. `2^(0+1i)` is well-conditioned and
  % matches across runners.
  disp((2)^(0+1i));
end

function test_unary_minus()
  z = 1 - 2i;
  disp(-z);
  disp(-(2i));
end

function test_compare_eq_ne()
  z = 1 + 2i;
  w = 1 + 2i;
  disp(z == w);
  disp(z == (1 - 2i));
  disp(z ~= (1 - 2i));
  % Real vs complex with zero imag: equal.
  disp((1 + 0i) == 1);
  disp(1 == (1 + 0i));
end

function test_compare_rel()
  % MATLAB compares on real part only for <, <=, >, >=.
  z = 1 + 5i;
  w = 2 - 3i;
  disp(z < w);
  disp(z > w);
  disp(z <= 1);
  disp(z >= 1);
end

function test_if_cond()
  if 1i
    disp(10);
  else
    disp(20);
  end
  if 0i
    disp(30);
  else
    disp(40);
  end
  z = 1 + 2i;
  %!numbl:opaque z
  if z
    disp(50);
  end
end

function test_while_cond()
  k = 0;
  z = 1 + 0i;
  %!numbl:opaque z
  while z
    k = k + 1;
    if k >= 3
      z = 0 + 0i;
    end
  end
  disp(k);
end

function test_through_func()
  z = 1 + 2i;
  disp(double_it(z));
end

function out = double_it(z)
  out = 2 * z;
end

% Complex tensor literals — row vector, matrix, mixed real/complex cells.
function test_tensor_literals()
  disp([1i, 2i, 3i]);
  disp([1+2i, 3-4i]);
  disp([1+1i, 2-2i; 3-3i, 4+4i]);
  % Mixed real and complex cells in the same row → complex result.
  disp([1, 2+1i; 3-1i, 4]);
  % Pure imaginary literal in a matrix slot.
  disp([0i, 1i; -1i, 0i]);
end

% Disp of stored complex tensor (no fold path on a Var read).
function test_tensor_disp()
  z = [1+2i, 3, 5i];
  disp(z);
  m = [1+1i, 2; 0, 3-3i];
  disp(m);
end

% A second Var pointing at the same source: confirm the per-tensor
% copy-on-assign path duplicates both lanes, not just `real`.
function test_tensor_copy()
  a = [1i, 2+1i, 3];
  b = a;
  disp(b);
  % Re-disp a — should still see the original values.
  disp(a);
end

% Pass complex tensor to a user function and return it.
function test_tensor_pass_to_func()
  z = [1+1i, 2-2i, 3+3i];
  w = identity(z);
  disp(w);
end

function out = identity(t)
  out = t;
end

% complex_tensor + complex_tensor (and -, .*, ./) — same shape (_tt).
function test_tensor_arith_tt()
  a = [1+1i, 2+2i, 3+3i];
  b = [10-1i, 20-2i, 30-3i];
  disp(a + b);
  disp(a - b);
  disp(a .* b);
  disp(b ./ a);
end

% complex_tensor + complex_scalar / + real_scalar (_ts path).
function test_tensor_arith_ts()
  a = [1+1i, 2+2i, 3+3i];
  disp(a + (1+1i));
  disp(a * 2i);
  disp(a - 1);
  disp(a ./ 2);
end

% complex_scalar OP complex_tensor (_st path for non-commutative ops).
function test_tensor_arith_st()
  a = [1+1i, 2+2i, 3+3i];
  disp((10+0i) - a);
  disp(10i ./ a);
end

% Broadcasting: complex column / complex row.
function test_tensor_arith_bcast()
  col = [1i; 2i; 3i];
  row = [10, 20];
  disp(col + row);
end

% Mixed real_tensor + complex_tensor (and vice versa).
function test_tensor_arith_mixed_real()
  c = [1+1i, 2+2i, 3+3i];
  r = [10, 20, 30];
  disp(c + r);
  disp(r + c);
  disp(c - r);
  disp(r - c);
  disp(c .* r);
  disp(c ./ r);
  disp(-c);
end
