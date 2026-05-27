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
test_real_lift_scalar();
test_real_lift_tensor();
test_real_lift_opaque();
test_complex_predicates_scalar();
test_complex_predicates_tensor();
test_complex_not();
test_complex_shape_flip();
test_complex_shape_repmat();
test_complex_shape_triangular();
test_complex_shape_diag();
test_complex_shape_cat();
test_complex_cumulative();
test_complex_sort();
test_complex_dot();

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

% sqrt / log / log2 / log10 of real inputs that leave the real domain
% lift to the complex path. Scalar exact-fold path.
function test_real_lift_scalar()
  disp(sqrt(-1));
  disp(sqrt(-4));
  disp(log(-1));
  disp(log2(-4));
  disp(log10(-100));
end

% sqrt / log lift on real tensor inputs (mix of negative and non-negative
% entries → sign:nonzero → lifts; result is a complex tensor).
function test_real_lift_tensor()
  disp(sqrt([-1, 4, -9]));
  disp(log([-1, 1, -exp(1)]));
end

% Opaque (sign-stripped → unknown) real input lifts on the runtime path,
% no compile-time exact-fold available.
function test_real_lift_opaque()
  x = -1;
  %!numbl:opaque x
  disp(sqrt(x));

  y = -2;
  %!numbl:opaque y
  disp(log(y));

  z = [-1, 4, -9];
  %!numbl:opaque z
  disp(sqrt(z));
end

% Per-component NaN/Inf/finite checks on complex scalars: any
% NaN-component → isnan true; any Inf-component → isinf true;
% all-finite → isfinite true (matches numbl / MATLAB).
function test_complex_predicates_scalar()
  z = 1 + 2i;
  disp(isnan(z));
  disp(isnan(NaN + 0i));
  disp(isnan(1 + NaN*1i));
  disp(isinf(Inf + 0i));
  disp(isinf(1 + Inf*1i));
  disp(isinf(z));
  disp(isfinite(z));
  disp(isfinite(Inf + 0i));
  disp(isfinite(1 + NaN*1i));
end

% Same predicates on complex tensors — exercises the
% `_complex` per-element runtime helper.
function test_complex_predicates_tensor()
  v = [1+1i, NaN+0i, Inf+0i, 0+NaN*1i];
  disp(isnan(v));
  disp(isinf(v));
  disp(isfinite(v));
end

% Logical NOT on complex scalars and tensors. Zero in both
% components is "true" under `~`; any nonzero component → "false".
function test_complex_not()
  disp(~(0+0i));
  disp(~(1+0i));
  disp(~(0+1i));
  w = [0+0i, 1+0i, 0+1i, 2+3i];
  disp(~w);
end

% flip / flipud / fliplr on complex tensors — both lanes are
% mirrored along the chosen axis.
function test_complex_shape_flip()
  v = [1+1i, 2-2i, 3+3i, 4-4i];
  disp(flip(v));
  m = [1+1i, 2; 3, 4-4i];
  disp(flipud(m));
  disp(fliplr(m));
end

% repmat on complex scalar / tensor inputs — tile both lanes.
function test_complex_shape_repmat()
  disp(repmat(1+2i, 2, 3));
  disp(repmat([1+1i, 2-2i], 2, 1));
  disp(repmat([1+1i; 2-2i], 1, 3));
end

% triu / tril on complex tensors — kept entries copy both lanes,
% rejected entries zero both lanes.
function test_complex_shape_triangular()
  m = [1+1i, 2+2i, 3; 4-4i, 5+5i, 6-6i; 7+7i, 8-8i, 9+9i];
  disp(triu(m));
  disp(tril(m));
  disp(triu(m, 1));
  disp(tril(m, -1));
end

% diag on complex inputs: construct from vector, extract from matrix,
% scalar-on-off-diagonal, and the degenerate diagLen=1 scalar form.
function test_complex_shape_diag()
  v = [1+1i, 2-2i, 3+3i];
  disp(diag(v));
  disp(diag(v, 1));
  m = [1+1i, 2; 3-3i, 4+4i];
  disp(diag(m));
  disp(diag(m, 1));
  disp(diag(5+3i));
  disp(diag(5+3i, 1));
end

% cat: pure complex, complex + real mix, and complex scalar splice.
function test_complex_shape_cat()
  disp(cat(1, [1+1i, 2], [3, 4-4i]));
  disp(cat(2, [1+1i; 2-2i], [3+3i; 4]));
  disp(cat(1, [1+1i, 2], [3, 4]));
  disp(cat(2, 1+1i, 2-2i, 3));
end

% cumsum / cumprod on complex tensors. cumprod walks both lanes via
% complex multiplication; cumsum is component-wise.
function test_complex_cumulative()
  v = [1+1i, 2-2i, 3+3i, 4-4i];
  disp(cumsum(v));
  disp(cumprod(v));
  m = [1+1i, 2; 3-3i, 4+4i];
  disp(cumsum(m));
  disp(cumsum(m, 2));
  disp(cumprod(m));
  % Opaque path forces the runtime kernel.
  w = [1+1i, 2-2i, 3+3i];
  %!numbl:opaque w
  disp(cumsum(w));
  disp(cumprod(w));
end

% sort on complex vectors — order by magnitude (then phase as
% tiebreak), matching numbl / MATLAB.
function test_complex_sort()
  v = [3-3i, 1+1i, 4+0i, 1-1i, 5+5i];
  disp(sort(v));
  disp(sort(v, 'descend'));
  [s, ix] = sort(v);
  disp(s);
  disp(ix);
  % Column vector
  c = [3+0i; 1+2i; 2-1i];
  disp(sort(c));
  % Opaque path forces the runtime kernel.
  w = [3+0i, 1+0i, 2+0i, 1+0i];
  %!numbl:opaque w
  disp(sort(w));
end

% `dot` on complex (and mixed) vectors / matrices. Numbl/MATLAB use
% `sum(conj(a) .* b)`; the result is complex whenever either operand
% is complex.
function test_complex_dot()
  a = [1+1i, 2-2i];
  b = [3+0i, 4+4i];
  disp(dot(a, b));
  % Real + complex mix
  disp(dot([1, 2], [1+1i, 2-2i]));
  disp(dot([1+1i, 2-2i], [1, 2]));
  % Matrix form (column-wise dot)
  M = [1+1i, 2; 3, 4-4i];
  N = [0+1i, 1; 2, 0+3i];
  disp(dot(M, N));
  % Opaque path
  x = [1+1i, 2-2i];
  y = [3+0i, 4+4i];
  %!numbl:opaque x y
  disp(dot(x, y));
end
