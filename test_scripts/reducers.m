% Reductions: sum / prod / mean / min / max / any / all over scalars,
% vectors, and matrices, with default and explicit dim.

test_scalar_identity();
test_sum_vector();
test_prod_vector();
test_mean_vector();
test_min_max_vector();
test_any_all_vector();
test_sum_matrix_default();
test_prod_matrix_default();
test_mean_matrix_default();
test_min_max_matrix_default();
test_any_all_matrix_default();
test_sum_matrix_explicit_dim();
test_prod_matrix_explicit_dim();
test_min_max_explicit_dim();
test_any_all_explicit_dim();
test_3d_explicit_dim();
test_all_literal();
test_exact_fold_small();
test_runtime_large_drops_exact();
test_slice_provably_scalar();
test_sum_runtime_known_shape();
test_min_max_nan_input();
test_any_all_mixed_zeros();
test_sum_negative_values();
test_prod_negative_values();
test_mean_runtime();
test_empty_logical_via_zeros();
test_complex_reductions();

function test_scalar_identity()
  % Scalar identity for every reducer.
  disp(sum(7));
  disp(prod(7));
  disp(mean(7));
  disp(min(7));
  disp(max(7));
  disp(any(7));
  disp(all(7));

  % Scalar zero / negative.
  disp(sum(0));
  disp(any(0));
  disp(all(0));
  disp(any(-3));
  disp(all(-3));
end

function test_sum_vector()
  disp(sum([1 2 3 4 5]));
  disp(sum([1; 2; 3; 4; 5]));
  disp(sum([1.5 2.5 3.5]));
end

function test_prod_vector()
  disp(prod([1 2 3 4]));
  disp(prod([2; 3; 4]));
  disp(prod([1.5 2.0]));
end

function test_mean_vector()
  disp(mean([1 2 3 4 5]));
  disp(mean([1; 2; 3]));
  disp(mean([1 2 3 4]));
end

function test_min_max_vector()
  disp(min([3 1 4 1 5 9 2 6]));
  disp(max([3 1 4 1 5 9 2 6]));
  disp(min([-3 -1 0 2]));
  disp(max([-3 -1 0 2]));
end

function test_any_all_vector()
  disp(any([0 0 0 1]));
  disp(any([0 0 0 0]));
  disp(all([1 2 3 4]));
  disp(all([1 0 1 1]));
end

function test_sum_matrix_default()
  % Headline case: matrix → row vector via default first-non-singleton.
  m = [1 2 3; 4 5 6];
  disp(sum(m));
end

function test_prod_matrix_default()
  disp(prod([1 2; 3 4]));
end

function test_mean_matrix_default()
  disp(mean([2 4; 6 8]));
end

function test_min_max_matrix_default()
  disp(min([3 1 4; 1 5 9]));
  disp(max([3 1 4; 1 5 9]));
end

function test_any_all_matrix_default()
  disp(any([0 1 0; 0 0 1]));
  disp(all([1 1 1; 1 0 1]));
end

function test_sum_matrix_explicit_dim()
  m = [1 2 3; 4 5 6];
  disp(sum(m, 1));
  disp(sum(m, 2));
end

function test_prod_matrix_explicit_dim()
  m = [1 2; 3 4; 5 6];
  disp(prod(m, 1));
  disp(prod(m, 2));
end

function test_min_max_explicit_dim()
  m = [3 1 4; 1 5 9; 2 6 5];
  disp(min(m, [], 1));
  disp(min(m, [], 2));
  disp(max(m, [], 1));
  disp(max(m, [], 2));
end

function test_any_all_explicit_dim()
  m = [1 0 1; 0 1 0];
  disp(any(m, 1));
  disp(any(m, 2));
  disp(all(m, 1));
  disp(all(m, 2));
end

function test_3d_explicit_dim()
  % 3-D tensor with explicit dim. Use `zeros(2, 3, 4)` then mutate
  % so we have predictable values.
  t = zeros(2, 3, 4);
  for i = 1:2
    for j = 1:3
      for k = 1:4
        t(i, j, k) = i + j + k;
      end
    end
  end
  disp(sum(t, 1));
  disp(sum(t, 3));
end

function test_all_literal()
  % 'all' literal flag — collapses everything to a single scalar.
  m = [1 2 3; 4 5 6];
  disp(sum(m, 'all'));
  disp(prod(m, 'all'));
  disp(mean(m, 'all'));
  disp(min(m, [], 'all'));
  disp(max(m, [], 'all'));
  disp(any([0 0; 0 1], 'all'));
  disp(all([1 1; 1 0], 'all'));
end

function test_exact_fold_small()
  % Small tensor (<= 256 elements) — exact-fold path computes the
  % result at compile time. The output should still match the
  % runtime path byte-for-byte.
  disp(sum([1 2 3; 4 5 6]));
  disp(prod([1 2 3 4 5]));
  disp(mean([10 20 30 40]));
  disp(min([5 4 3 2 1]));
  disp(max([1 2 3 4 5]));
end

function test_runtime_large_drops_exact()
  % Build a >256-element tensor (zeros(20, 20) = 400). The exact
  % cap kicks in so the transfer drops `exact` and codegen falls
  % through to the runtime helper.
  m = zeros(20, 20);
  for i = 1:20
    for j = 1:20
      m(i, j) = i + j;
    end
  end
  disp(sum(m, 'all'));
  disp(mean(m, 'all'));
  disp(max(m, [], 'all'));
end

function test_slice_provably_scalar()
  % Second headline case: a slice whose lattice proves the result is
  % effectively a vector. `M(:, 2)` on a known-shape matrix
  % produces a column vector; sum'ing it collapses to scalar.
  M = zeros(3, 5);
  for i = 1:3
    for j = 1:5
      M(i, j) = i * 10 + j;
    end
  end
  disp(sum(M(:, 2)));
  disp(sum(M(:, 2:4)));
  disp(sum(M(2, :)));
end

function test_sum_runtime_known_shape()
  % Tensor variable with shape preserved through %!numbl:opaque
  % (opaque only strips exact). Forces the runtime path.
  a = [1 2 3 4 5];
  %!numbl:opaque a
  disp(sum(a));
  disp(prod(a));
  disp(mean(a));
  disp(min(a));
  disp(max(a));

  m = [1 2; 3 4];
  %!numbl:opaque m
  disp(sum(m));
  disp(sum(m, 1));
  disp(sum(m, 2));
end

function test_min_max_nan_input()
  % NaN-skip convention from numbl. mtoc2's runtime mirrors it.
  v = [1 2 0 3];
  %!numbl:opaque v
  v(3) = 0 / 0;
  disp(min(v));
  disp(max(v));
end

function test_any_all_mixed_zeros()
  v = [0 0 1 0 0];
  %!numbl:opaque v
  disp(any(v));
  disp(all(v));

  w = [1 1 1 1];
  %!numbl:opaque w
  disp(any(w));
  disp(all(w));

  z = [0 0 0];
  %!numbl:opaque z
  disp(any(z));
  disp(all(z));
end

function test_sum_negative_values()
  % Sign refinement is a static thing; here we just confirm the
  % runtime path returns the right values.
  v = [-1 -2 -3 -4];
  %!numbl:opaque v
  disp(sum(v));
  disp(mean(v));
end

function test_prod_negative_values()
  v = [-2 3 -4];
  %!numbl:opaque v
  disp(prod(v));
end

function test_mean_runtime()
  m = [1 2 3; 4 5 6];
  %!numbl:opaque m
  disp(mean(m));
  disp(mean(m, 2));
  disp(mean(m, 'all'));
end

function test_empty_logical_via_zeros()
  % Empty input for any/all (via zeros(0, 3) → 0x3 empty tensor).
  % - any of empty → 0
  % - all of empty → 1
  e = zeros(0, 3);
  disp(any(e, 'all'));
  disp(all(e, 'all'));
end

% Reductions on complex tensors: sum/prod/mean (lane-pair accumulator),
% min/max (magnitude-compare with atan2 tiebreak), any/all (toBool per
% element). Covers default axis, explicit dim, and the 'all' literal.
function test_complex_reductions()
  v = [1+1i, 2+2i, 3+3i];
  %!numbl:opaque v
  disp(sum(v));
  disp(prod(v));
  disp(mean(v));
  disp(min(v));
  disp(max(v));
  disp(any(v));
  disp(all(v));
  m = [1+1i, 2-2i; 3+3i, 4-4i];
  %!numbl:opaque m
  disp(sum(m));
  disp(sum(m, 2));
  disp(sum(m, 'all'));
  disp(min(m, [], 2));
  disp(max(m));
  % any with a complex zero in the mix.
  z = [0+0i, 0+1i, 0+0i];
  %!numbl:opaque z
  disp(any(z));
  disp(all(z));
end
