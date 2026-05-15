test_scalar_exact_unary();
test_scalar_runtime_unary();
test_tensor_exact_unary();
test_tensor_runtime_unary();
test_tensor_large_runtime();
test_sqrt_log_positive();
test_round_matlab_style();
test_constants();
test_constants_in_arith();
test_binary_scalar();
test_binary_tensor();
test_binary_runtime();
test_logical_input();
test_in_loop();
test_pass_to_func();
test_minmax_two_arg();
test_sign_propagation_chain();
test_complex_part_builtins();
test_complex_abs_angle();

function test_scalar_exact_unary()
  % Trig
  disp(cos(0));
  disp(sin(0));
  disp(tan(0));
  disp(atan(1));
  % exp / log
  disp(exp(0));
  disp(exp(1));
  disp(log(1));
  disp(log2(8));
  disp(log10(1000));
  % abs / sign
  disp(abs(-7.5));
  disp(abs(0));
  disp(sign(-3));
  disp(sign(0));
  disp(sign(4));
  % rounding family
  disp(floor(2.7));
  disp(floor(-2.3));
  disp(ceil(2.3));
  disp(ceil(-2.7));
  disp(fix(2.7));
  disp(fix(-2.7));
  disp(round(2.4));
  disp(round(2.5));
  disp(round(-2.5));
  disp(round(-2.4));
  % sqrt
  disp(sqrt(0));
  disp(sqrt(4));
  disp(sqrt(2));
end

function test_scalar_runtime_unary()
  % Force runtime path by stripping exact via opaque
  x = 0;
  %!numbl:opaque x
  disp(cos(x));
  disp(sin(x));

  y = 4;
  %!numbl:opaque y
  disp(sqrt(y));
  disp(log(y));
  disp(log2(y));

  z = -3.7;
  %!numbl:opaque z
  disp(abs(z));
  disp(sign(z));
  disp(floor(z));
  disp(ceil(z));
  disp(fix(z));
  disp(round(z));

  w = 1.5;
  %!numbl:opaque w
  disp(exp(w));
  disp(atan(w));
  disp(tan(w));
end

function test_tensor_exact_unary()
  % Tensor exact-fold (small enough to stay in the type-level path)
  disp(cos([0 0 0]));
  disp(sin([0 0 0]));
  disp(abs([-1 -2 3 4]));
  disp(sign([-2 -1 0 1 2]));
  disp(floor([1.5 2.3 -1.5 -2.3]));
  disp(ceil([1.5 2.3 -1.5 -2.3]));
  disp(round([1.4 1.5 -1.5 -1.4 2.5 -2.5]));
  disp(fix([1.7 -1.7 2.5 -2.5]));
  disp(sqrt([0 1 4 9]));
  disp(exp([0 0 0]));
  disp(log([1 1 1]));
end

function test_tensor_runtime_unary()
  a = [1 2 3 4];
  %!numbl:opaque a
  disp(cos(a));
  disp(sin(a));
  disp(abs(a));
  disp(sqrt(a));
  disp(log(a));
  disp(exp(a));
  disp(floor(a));
  disp(sign(a));

  m = [1 4; 9 16];
  %!numbl:opaque m
  disp(sqrt(m));
  disp(log2(m));
end

function test_tensor_large_runtime()
  % zeros(400, 1) -> 400 elements, above EXACT_ARRAY_MAX_ELEMENTS = 256.
  % cos(zeros(400,1)) takes the runtime path; elements all equal
  % cos(0) = 1, so the sum is 400. Using a column vector keeps the
  % result rankable by `sum` (which is vector-only in mtoc2 v1).
  z = zeros(400, 1);
  disp(sum(cos(z)));
  % sin(zeros) is all-zero; sum 0.
  disp(sum(sin(z)));
  % exp(zeros) is all-ones; sum is 400.
  disp(sum(exp(z)));
  % abs(ones) is ones; sum 400.
  o = ones(400, 1);
  disp(sum(abs(o)));
end

function test_sqrt_log_positive()
  % Positive scalar paths
  disp(sqrt(0.25));
  disp(log(exp(1)));
  disp(log(exp(2)));
  disp(log2(2));
  disp(log10(10));
  disp(log10(100));
  % Compose with abs (statically nonneg)
  x = -5;
  disp(sqrt(abs(x)));
end

function test_round_matlab_style()
  % MATLAB rounds ties away from zero (not toward +Inf like JS).
  disp(round(0.5));
  disp(round(-0.5));
  disp(round(1.5));
  disp(round(-1.5));
  disp(round(2.5));
  disp(round(-2.5));

  % Runtime path (after opaque)
  a = 0.5;
  %!numbl:opaque a
  disp(round(a));
  b = -0.5;
  %!numbl:opaque b
  disp(round(b));
  c = -2.5;
  %!numbl:opaque c
  disp(round(c));
end

function test_constants()
  disp(pi);
  disp(eps);
  disp(Inf);
  disp(inf);
  disp(-Inf);
  disp(NaN);
  disp(nan);
  % paren-form also works
  disp(pi());
end

function test_constants_in_arith()
  disp(2 * pi);
  disp(pi / 4);
  disp(pi + pi);
  disp(cos(pi));
  disp(sin(pi));
  disp(cos(2 * pi));
  disp(exp(1));
end

function test_binary_scalar()
  % mod / rem: sign-of-b vs sign-of-a
  disp(mod(5, 3));
  disp(mod(-5, 3));
  disp(mod(5, -3));
  disp(mod(-5, -3));
  disp(rem(5, 3));
  disp(rem(-5, 3));
  disp(rem(5, -3));
  disp(rem(-5, -3));
  % mod by zero returns a
  disp(mod(7, 0));

  disp(atan2(1, 1));
  disp(atan2(1, 0));
  disp(atan2(0, 1));
  disp(atan2(-1, -1));

  disp(hypot(3, 4));
  disp(hypot(5, 12));
  disp(hypot(0, 0));
end

function test_binary_tensor()
  % tensor + scalar, scalar + tensor, tensor + tensor
  disp(mod([5 6 7], 3));
  disp(mod(10, [3 4 5]));
  disp(mod([10 20 30], [3 4 5]));

  disp(rem([5 -5 7], 3));
  disp(atan2([1 0 -1], [1 1 1]));
  disp(hypot([3 5], [4 12]));
end

function test_binary_runtime()
  a = 5;
  b = 3;
  %!numbl:opaque a b
  disp(mod(a, b));
  disp(rem(a, b));
  disp(atan2(a, b));
  disp(hypot(a, b));

  v = [10 20 30];
  w = [3 4 5];
  %!numbl:opaque v w
  disp(mod(v, w));
  disp(hypot(v, w));
end

function test_logical_input()
  % logical promotes to double (stored as double in C)
  t = (1 == 1);
  disp(cos(t));
  disp(abs(t));
  disp(sqrt(t));
end

function test_in_loop()
  s = 0;
  for k = 1:5
    s = s + cos(k);
  end
  disp(s);

  t = 0;
  for k = 1:4
    t = t + sqrt(k);
  end
  disp(t);
end

function test_pass_to_func()
  disp(unit_circle(0));
  disp(unit_circle(pi / 2));
  disp(unit_circle(pi));
  disp(distance(3, 4));
  disp(distance(5, 12));
end

function r = unit_circle(t)
  r = cos(t) + sin(t);
end

function d = distance(x, y)
  d = sqrt(x * x + y * y);
end

% Elementwise 2-arg form of `max`/`min` on scalars. Backed by C99
% `fmax`/`fmin`. NaN follows MATLAB semantics: the non-NaN operand
% wins.
function test_minmax_two_arg()
  disp(max(3, 5));
  disp(min(3, 5));
  disp(max(-7, -2));
  disp(min(-7, -2));
  disp(max(7 - 10, 0));
  disp(min(NaN, 4));
  disp(max(NaN, 4));
  disp(max(NaN, NaN));
  a = 3;
  b = 5;
  %!numbl:opaque a b
  disp(max(a, b));
  disp(min(a, b));
end

% Sign-tracking improvements: even-integer power → nonneg, nonneg ⊗
% nonneg → nonneg (multiply / divide). Without these, the `sqrt`
% domain check would reject `chunkerfunc.m`'s spectral resolution
% chain. The runtime values match numbl; the test exists to lock in
% the static accept.
function test_sign_propagation_chain()
  d = [-1, -2, -3; -4, -5, -6];
  %!numbl:opaque d
  v = sqrt(sum(d .^ 2, 1));
  disp(v);
  e = sqrt(sum(abs(d).^2 / 4, 1));
  disp(e);
end

% real / imag / conj on both real and complex scalar inputs.
function test_complex_part_builtins()
  % Real input: real(x) == x, imag(x) == 0, conj(x) == x.
  disp(real(3.5));
  disp(imag(3.5));
  disp(conj(3.5));
  % Complex literal.
  z = 1 + 2i;
  disp(real(z));
  disp(imag(z));
  disp(conj(z));
  % Pure imaginary.
  w = -3i;
  disp(real(w));
  disp(imag(w));
  disp(conj(w));
  % Pass through a runtime value (no fold).
  %!numbl:opaque z
  disp(real(z));
  disp(imag(z));
  disp(conj(z));
end

% abs / angle on complex scalars.
function test_complex_abs_angle()
  disp(abs(3 + 4i));
  disp(abs(-5i));
  disp(angle(1));
  disp(angle(-1));
  disp(angle(1i));
  disp(angle(1 + 1i));
  % Opaque path.
  z = 3 + 4i;
  %!numbl:opaque z
  disp(abs(z));
end
