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
test_eye_basics();
test_eye_runtime();
test_meshgrid_two_arg();
test_meshgrid_one_arg();
test_meshgrid_single_output();
test_meshgrid_opaque_inputs();

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

function test_eye_basics()
  % Empty, scalar-collapse, square, and non-square exact forms.
  disp(size(eye(0)));
  disp(eye(1));
  disp(eye(3));
  disp(eye(2, 3));
  disp(eye(3, 2));
  disp(eye(4, 4));
  disp(size(eye(2, 0)));
  disp(size(eye(0, 3)));
end

function test_eye_runtime()
  % Runtime (non-exact) dims: both single-arg square and 2-arg rect.
  n = 3;
  %!numbl:opaque n
  disp(eye(n));
  m = 2;
  %!numbl:opaque m
  disp(eye(m, n));
end

function test_meshgrid_two_arg()
  [X, Y] = meshgrid([1 2 3], [10 20]);
  disp(X);
  disp(Y);
  disp(size(X));
end

function test_meshgrid_one_arg()
  [X, Y] = meshgrid([1 2 3]);
  disp(X);
  disp(Y);
end

function test_meshgrid_single_output()
  X = meshgrid([1 2], [10 20 30]);
  disp(X);
  Z = meshgrid([5 6 7]);
  disp(Z);
end

function test_meshgrid_opaque_inputs()
  % Force the runtime path by hiding the exact data behind an opaque
  % marker; both single-output and multi-output cases should still
  % produce the same grids as the type-folded path above.
  x = [1 2 3 4];
  y = [10 20 30];
  %!numbl:opaque x y
  [X, Y] = meshgrid(x, y);
  disp(X);
  disp(Y);
  Z = meshgrid(x, y);
  disp(Z);
end
