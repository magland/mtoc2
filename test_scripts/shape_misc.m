% Shape / construction edge cases: trailing-singleton trim, negative
% dim clamp, empty-tensor disp, sum on a vector with unknown shape,
% and exact-tracking discipline around non-finite values.

test_construct_trim_trailing();
test_zeros_negative_dim_clamp();
test_disp_empty();
test_sum_known_row_vector();
test_sum_known_col_vector();
test_sum_unknown_shape_row_vector_field();
test_exact_finite_discipline();

function test_construct_trim_trailing()
  A = zeros(3, 2, 1);
  disp(A);
  disp(size(A));
  B = ones(2, 1, 1, 1);
  disp(B);
  disp(size(B));
  C = zeros([3 2 1]);
  disp(size(C));
end

function test_zeros_negative_dim_clamp()
  % Negative runtime dims should clamp to 0 (empty tensor), not abort.
  n = 0;
  %!numbl:opaque n
  A = zeros(n - 1, 3);
  disp(size(A));
  B = ones(2, n - 5);
  disp(size(B));
  m = 4;
  %!numbl:opaque m
  C = zeros(m, m - 10);
  disp(size(C));
end

function test_disp_empty()
  disp(zeros(0, 0));
  disp(1);
  disp(zeros(0, 3));
  disp(2);
  disp(zeros(3, 0));
  disp(3);
  disp(zeros(2, 3, 0));
  disp(4);
  disp(zeros(0, 5, 3));
  disp(5);
end

function test_sum_known_row_vector()
  v = [1 2 3 4];
  disp(sum(v));
end

function test_sum_known_col_vector()
  M = zeros(3, 1);
  M(1) = 10; M(2) = 20; M(3) = 30;
  disp(sum(M));
end

function test_sum_unknown_shape_row_vector_field()
  % Field declared with at least one `one` axis stays accepted.
  s = struct('v', [1 2 3 4 5]);
  disp(sum(s.v));
end

function test_exact_finite_discipline()
  % The type lattice's `exact` must only carry finite values. Without
  % the discipline, scalar / tensor folds bake NaN and ±Infinity into
  % the exact slot; the canonical spec key uses JSON.stringify, which
  % collapses every non-finite to `null` → distinct exact tensors
  % collide on the specialization key.

  n = prod([1/0, 0]);
  disp(n);

  m = sum([1/0, 1]);
  disp(m);

  k = -(1/0);
  disp(k);

  a = [1/0, 0];
  b = [0, 1/0];
  disp(use_exact(a));
  disp(use_exact(b));
end

function y = use_exact(t)
  y = sum(t);
end
