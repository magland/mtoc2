test_row_vec_disp();
test_col_vec_disp();
test_matrix_disp();
test_scalar_tensor();
test_length();
test_numel();
test_sum();
test_pass_to_func();
test_runtime_disp_row();
test_runtime_disp_col();
test_runtime_disp_matrix();
test_runtime_var_copy();
test_disp_inline_hoist();
test_runtime_in_loop();
test_length_numel_after_opaque();
test_arith_exact_fold();
test_arith_runtime_tt();
test_arith_runtime_scalar_broadcast();
test_arith_implicit_expansion();
test_arith_implicit_expansion_runtime();
test_arith_nested();
test_sum_runtime();
test_arith_in_loop();
test_tensor_loop_reassign();

function test_row_vec_disp()
  disp([1 2 3]);
  disp([1.5 2.5 3.5]);
  disp([1 -2 3]);
end

function test_col_vec_disp()
  disp([1; 2; 3]);
  disp([10; 20; 30]);
end

function test_matrix_disp()
  disp([1 2; 3 4]);
  disp([1 22; 333 4]);
  disp([1 2 3; 4 5 6]);
end

function test_scalar_tensor()
  disp([7]);
  disp([-3]);
  disp([1.5]);
end

function test_length()
  disp(length([1 2 3 4 5]));
  disp(length([1; 2; 3]));
  disp(length([1 2; 3 4]));
  disp(length([1 2 3; 4 5 6]));
  disp(length(7));
end

function test_numel()
  disp(numel([1 2 3 4 5]));
  disp(numel([1; 2; 3]));
  disp(numel([1 2; 3 4]));
  disp(numel([1 2 3; 4 5 6]));
  disp(numel(7));
end

function test_sum()
  disp(sum([1 2 3 4]));
  disp(sum([1; 2; 3]));
  disp(sum([10 20 30]));
  disp(sum(7));
end

function test_pass_to_func()
  disp(sumsq([3 4]));
  disp(triangular_sum(10));
end

function test_runtime_disp_row()
  a = [1 2 3];
  %!numbl:opaque a
  disp(a);

  b = [1.5 -2 0.25];
  %!numbl:opaque b
  disp(b);
end

function test_runtime_disp_col()
  a = [1; 2; 3];
  %!numbl:opaque a
  disp(a);

  b = [10; 20; 30; 40];
  %!numbl:opaque b
  disp(b);
end

function test_runtime_disp_matrix()
  a = [1 2; 3 4];
  %!numbl:opaque a
  disp(a);

  b = [1 22; 333 4];
  %!numbl:opaque b
  disp(b);

  c = [1 2 3; 4 5 6];
  %!numbl:opaque c
  disp(c);
end

function test_runtime_var_copy()
  a = [1 2 3 4];
  %!numbl:opaque a
  b = a;
  disp(b);
  disp(a);
end

function test_disp_inline_hoist()
  x = 7;
  %!numbl:opaque x
  disp([x 1 2 3]);
  disp([10 x 20]);
  disp([x; x+1; x+2]);
end

function test_runtime_in_loop()
  for k = 1:3
    disp([k k*10 k*100]);
  end

  s = 0;
  for k = 1:4
    v = [k k+1 k+2];
    disp(v);
    s = s + k;
  end
  disp(s);
end

function test_length_numel_after_opaque()
  a = [1 2 3 4 5];
  %!numbl:opaque a
  disp(length(a));
  disp(numel(a));

  b = [1 2 3; 4 5 6];
  %!numbl:opaque b
  disp(length(b));
  disp(numel(b));
end

function test_arith_exact_fold()
  disp([1 2 3] + [10 20 30]);
  disp([1 2 3] - [4 5 6]);
  disp([1 2 3] .* [2 3 4]);
  disp([10 20 30] ./ [2 4 5]);
  disp([1 2 3] + 100);
  disp(7 - [1 2 3]);
  disp(2 * [1 2 3]);
  disp(-[1 -2 3]);
  disp([1 2; 3 4] + [10 20; 30 40]);
end

function test_arith_runtime_tt()
  a = [1 2 3];
  b = [10 20 30];
  %!numbl:opaque a b
  disp(a + b);
  disp(a - b);
  disp(a .* b);
  disp(a ./ b);

  c = [1 2; 3 4];
  d = [10 20; 30 40];
  %!numbl:opaque c d
  disp(c + d);
  disp(c - d);
  disp(c .* d);
end

function test_arith_runtime_scalar_broadcast()
  a = [1 2 3 4];
  %!numbl:opaque a
  disp(a + 10);
  disp(10 + a);
  disp(a - 1);
  disp(1 - a);
  disp(a * 2);
  disp(2 * a);
  disp(a .* 3);
  disp(3 .* a);
  disp(a / 2);
  disp(a ./ 2);
  disp(12 ./ a);
  disp(-a);
end

function test_arith_implicit_expansion()
  % Static-shape broadcast: every dim is exact at translate time, so
  % the result folds during the exact pass.
  col = [1; 2; 3];
  row = [10 20 30 40];
  disp(col + row);       % 3x1 + 1x4 -> 3x4
  disp(row - col);       % 1x4 - 3x1 -> 3x4
  disp(col .* row);      % 3x1 .* 1x4 -> 3x4
  disp(col ./ [1 2 4 8]);% 3x1 ./ 1x4 -> 3x4

  mat = [1 2; 3 4; 5 6];
  cv  = [10; 20; 30];
  rv  = [100 200];
  disp(mat + cv);        % 3x2 + 3x1 -> 3x2 (column broadcast)
  disp(mat + rv);        % 3x2 + 1x2 -> 3x2 (row broadcast)

  % Trailing-singleton implicit expansion: 2x1 + 2x4 (the chunkie
  % example's `ctr + rad*[cos(t); sin(t)]` pattern).
  ctr = [1.0; -0.5];
  trig = [0.1 0.2 0.3 0.4; 0.9 0.8 0.7 0.6];
  disp(ctr + trig);
end

function test_arith_implicit_expansion_runtime()
  % Same broadcast pattern but with at least one runtime-opaque arg so
  % the codegen path actually exercises `*_bcast_tt`.
  col = [1; 2; 3];
  row = [10 20 30 40];
  %!numbl:opaque col row
  disp(col + row);
  disp(row - col);
  disp(col .* row);
  disp(col ./ [1 2 4 8]);

  mat = [1 2; 3 4; 5 6];
  cv  = [10; 20; 30];
  rv  = [100 200];
  %!numbl:opaque mat cv rv
  disp(mat + cv);
  disp(mat + rv);
end

function test_arith_nested()
  a = [1 2 3];
  b = [10 20 30];
  c = [100 200 300];
  %!numbl:opaque a b c
  disp(a + b + c);
  disp(a - b + c);
  disp(a .* b + c);
  disp((a + b) .* c);
  disp(a + 2 * b);
  disp(-a + b);
end

function test_sum_runtime()
  a = [1 2 3 4 5];
  %!numbl:opaque a
  disp(sum(a));

  b = [1; 2; 3; 4];
  %!numbl:opaque b
  disp(sum(b));

  c = [1.5 2.5 3.5];
  %!numbl:opaque c
  disp(sum(c));

  % sum of an arith result (intermediate tensor materialized via hoist)
  d = [1 2 3];
  e = [10 20 30];
  %!numbl:opaque d e
  disp(sum(d + e));
  disp(sum(2 * d));
end

function test_arith_in_loop()
  a = [1 2 3];
  %!numbl:opaque a
  for k = 1:3
    disp(a + k);
    disp(k * a);
  end

  s = 0;
  for k = 1:5
    s = s + sum(a);
  end
  disp(s);
end

function test_tensor_loop_reassign()
  % Regression: a tensor initialized with a literal AND reassigned inside
  % a loop. Before "always-materialize" the initial assignment was elided
  % (TensorLit-RHS marked non-materializing), so the loop body read NULL
  % pointers from the empty-tensor pre-declaration and produced NaN.

  a = [1 2 3];
  for j = 1:2
    a = a + 1;
  end
  disp(a);

  % Same pattern with multiplication.
  b = [10 20];
  for j = 1:3
    b = 2 * b;
  end
  disp(b);

  % Matrix variant.
  m = [1 2; 3 4];
  for j = 1:2
    m = m + 1;
  end
  disp(m);

  % Tensor exact at start, opaque mid-flight, then mutated in loop.
  c = [100 200 300];
  %!numbl:opaque c
  for j = 1:2
    c = c + j;
  end
  disp(c);
end

function y = sumsq(v)
  s = sum(v);
  y = s * s;
end

function s = triangular_sum(n)
  s = sum([1 2 3 4 5 6 7 8 9 10]);
  s = s + n - n;
end
