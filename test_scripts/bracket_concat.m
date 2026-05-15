test_vertcat_scalar_rows();
test_horzcat_scalar_row();
test_vertcat_tensor_rows();
test_horzcat_tensor_row();
test_mixed_shapes();
test_scalar_and_tensor_horz();
test_scalar_and_tensor_vert();
test_3_level_vertcat();
test_empty_drop_simple();
test_empty_drop_horizontal();
test_matrix_concat_horz();
test_matrix_concat_vert();
test_matrix_concat_2x2_blocks();
test_runtime_vertcat();
test_runtime_horzcat();
test_runtime_mixed();
test_concat_in_assign();
test_concat_pass_to_func();
test_concat_with_arith();
test_concat_after_transpose();
test_singleton_tensor();
test_singleton_scalar();
test_exact_fold_small();
test_concat_dynamic_vert_close_loop();
test_concat_dynamic_vert_two_tensors();
test_concat_dynamic_horz_with_scalar();

function test_vertcat_scalar_rows()
  disp([1 2 3; 4 5 6]);
  disp([1; 2; 3]);
end

function test_horzcat_scalar_row()
  disp([1 2 3 4]);
end

function test_vertcat_tensor_rows()
  a = [1 2 3];
  b = [4 5 6];
  disp([a; b]);
  disp([a; b; a]);
end

function test_horzcat_tensor_row()
  a = [1 2 3];
  b = [4 5 6];
  disp([a, b]);
  disp([a, b, a]);
end

function test_mixed_shapes()
  a = [1 2; 3 4];
  b = [5; 6];
  disp([a, b]);   % 2x3 result
end

function test_scalar_and_tensor_horz()
  v = [1 2 3];
  disp([0, v]);
  disp([v, 9]);
  disp([0, v, 9]);
end

function test_scalar_and_tensor_vert()
  v = [1 2 3];
  disp([0 0 0; v]);
  disp([v; 9 9 9]);
end

function test_3_level_vertcat()
  disp([[1 2]; [3 4]; [5 6]]);
end

function test_empty_drop_simple()
  disp([[]; [1 2 3]; []]);
end

function test_empty_drop_horizontal()
  disp([[], [1 2 3], []]);
end

function test_matrix_concat_horz()
  m1 = [1 2; 3 4];
  m2 = [5 6; 7 8];
  disp([m1, m2]);
end

function test_matrix_concat_vert()
  m1 = [1 2; 3 4];
  m2 = [5 6; 7 8];
  disp([m1; m2]);
end

function test_matrix_concat_2x2_blocks()
  a = [1 2; 3 4];
  b = [5 6; 7 8];
  c = [9 10; 11 12];
  d = [13 14; 15 16];
  disp([a b; c d]);
end

function test_runtime_vertcat()
  a = [1 2 3];
  b = [4 5 6];
  %!numbl:opaque a b
  disp([a; b]);
end

function test_runtime_horzcat()
  a = [1 2 3];
  b = [4 5 6];
  %!numbl:opaque a b
  disp([a, b]);
end

function test_runtime_mixed()
  a = [1 2; 3 4];
  b = [5; 6];
  %!numbl:opaque a b
  disp([a, b]);

  v = [10 20 30];
  %!numbl:opaque v
  disp([0, v, 99]);
end

function test_concat_in_assign()
  a = [1 2 3];
  b = [4 5 6];
  c = [a; b];
  disp(c);
  disp(sum(c(:)));
end

function test_concat_pass_to_func()
  a = [1 2 3];
  b = [4 5 6];
  disp(row_sum([a; b]));
end

function test_concat_with_arith()
  a = [1 2 3];
  b = [4 5 6];
  %!numbl:opaque a b
  disp([a; b] + 10);
  disp([a; b] .* 2);
end

function test_concat_after_transpose()
  a = [1 2 3];
  b = [4 5 6];
  disp([a.'; b.']);
  disp([a.', b.']);
end

function test_singleton_tensor()
  a = [1 2 3];
  disp([a]);   % returns a unchanged
end

function test_singleton_scalar()
  x = 7;
  disp([x]);   % returns x unchanged (existing 1x1 collapse)
end

function test_exact_fold_small()
  % Exact-known concat should fold. The visible output is the same
  % as the runtime path; this just exercises the fold code path.
  v = [1 2; 3 4];
  total = sum(sum(v));
  disp(total);
end

function s = row_sum(m)
  s = sum(m(:));
end

% -------- runtime-shape (TensorConcatDynamic) cells --------

function test_concat_dynamic_vert_close_loop()
  % Chunkie pattern: take a column vector of runtime length, append
  % its first element to close the loop. The cell shapes are
  % `[?,1]` and `[1,1]`, both with statically-known cols=1 but the
  % first cell's rows is unknown.
  n = 4;
  %!numbl:opaque n
  v = zeros(n, 1);
  v(1) = 10;
  v(2) = 20;
  v(3) = 30;
  v(4) = 40;
  disp([v; v(1)]);
end

function test_concat_dynamic_vert_two_tensors()
  % Two runtime-length column vectors vertcat'd together.
  n = 3;
  m = 2;
  %!numbl:opaque n m
  a = zeros(n, 1);
  b = zeros(m, 1);
  a(1) = 1; a(2) = 2; a(3) = 3;
  b(1) = 100; b(2) = 200;
  disp([a; b]);
end

function test_concat_dynamic_horz_with_scalar()
  % Horizontal concat where the tensor cell has runtime cols.
  n = 4;
  %!numbl:opaque n
  row = zeros(1, n);
  row(1) = 5; row(2) = 6; row(3) = 7; row(4) = 8;
  disp([row, 99]);
  disp([99, row]);
end
