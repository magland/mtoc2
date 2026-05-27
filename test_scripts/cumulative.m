% Topic file: cumsum / cumprod (prefix-scan builtins).
%
% Function-file form (no top-level statements; mtoc2 auto-invokes the
% first function). The entry function calls sibling locals that each
% exercise one slice of the supported surface. Only the AOT-supported
% forms are covered: real numeric vectors / matrices with statically-
% known shapes, and literal-integer dim args.

function cumulative()
  test_cumsum_scalar();
  test_cumsum_row_vector();
  test_cumsum_col_vector();
  test_cumsum_matrix_default();
  test_cumsum_matrix_dim();
  test_cumsum_dim_overflow();
  test_cumprod_scalar();
  test_cumprod_row_vector();
  test_cumprod_col_vector();
  test_cumprod_matrix_default();
  test_cumprod_matrix_dim();
  test_signs_and_negatives();
  test_nan_propagation();
  test_pass_to_func();
  disp('SUCCESS');
end

function test_cumsum_scalar()
  disp(cumsum(7));
  disp(cumsum(-3));
  disp(cumsum(0));
end

function test_cumsum_row_vector()
  disp(cumsum([1 2 3 4 5]));
  disp(cumsum([10 20 30]));
end

function test_cumsum_col_vector()
  disp(cumsum([1; 2; 3]));
  disp(cumsum([4; -1; 2; -3]));
end

function test_cumsum_matrix_default()
  M = [1 2 3; 4 5 6];
  disp(cumsum(M));
end

function test_cumsum_matrix_dim()
  M = [1 2 3; 4 5 6; 7 8 9];
  disp(cumsum(M, 1));
  disp(cumsum(M, 2));
  % dim=1 on a row vector — singleton axis, output equals input.
  disp(cumsum([1 2 3 4 5], 1));
  % dim=2 on a column vector — singleton axis, output equals input.
  disp(cumsum([1; 2; 3; 4; 5], 2));
end

function test_cumsum_dim_overflow()
  % dim > ndim: numbl emits a fresh copy.
  disp(cumsum([1 2 3 4 5], 3));
  M = [1 2; 3 4];
  disp(cumsum(M, 5));
end

function test_cumprod_scalar()
  disp(cumprod(6));
  disp(cumprod(-2));
  disp(cumprod(1));
end

function test_cumprod_row_vector()
  disp(cumprod([1 2 3 4 5]));
  disp(cumprod([2 2 2 2]));
end

function test_cumprod_col_vector()
  disp(cumprod([1; 2; 3]));
end

function test_cumprod_matrix_default()
  M = [1 2 3; 4 5 6];
  disp(cumprod(M));
end

function test_cumprod_matrix_dim()
  M = [1 2 3; 4 5 6; 7 8 9];
  disp(cumprod(M, 1));
  disp(cumprod(M, 2));
end

function test_signs_and_negatives()
  disp(cumsum([-1 -2 -3 -4]));
  disp(cumprod([1.5 2.0 -1.0 2.0]));
  disp(cumsum([0.5 0.25 0.125 0.0625]));
end

function test_nan_propagation()
  disp(cumsum([1 NaN 3 4]));
  disp(cumprod([1 NaN 3 4]));
end

function test_pass_to_func()
  % Make sure the result tensor flows through assigns / function calls
  % (exercises owned-value handoff in c-aot).
  v = cumsum([1 2 3 4 5]);
  disp(v);
  disp(double_it(v));
  w = cumprod([2 2 2]);
  disp(w);
end

function y = double_it(x)
  y = x * 2;
end
