% mtoc2-test-drop: ^\[matmul\] using bridge:.*$
% Real 2-D matrix multiplication. Scalar-on-either-side delegates to
% elementwise `times`; both-tensor takes the new `mtoc2_tensor_mtimes_real`
% runtime path.

test_outer_product();
test_inner_product();
test_row_times_matrix();
test_matrix_times_column();
test_square_matmul();
test_rectangular_matmul();
test_chained_matmul();
test_scalar_mtimes_still_works();
test_identity_like();
test_negative_signs();
test_in_expression_position();

function test_outer_product()
  % m×1 * 1×n → m×n.
  w = [1; 2; 3; 4];
  d = [10 20 30 40];
  disp(w * d);
end

function test_inner_product()
  % 1×k * k×1 → 1×1.
  a = [1 2 3];
  b = [4; 5; 6];
  disp(a * b);
end

function test_row_times_matrix()
  a = [1 2 3];
  M = [1 2; 3 4; 5 6];
  disp(a * M);
end

function test_matrix_times_column()
  M = [1 2 3; 4 5 6];
  v = [10; 20; 30];
  disp(M * v);
end

function test_square_matmul()
  A = [1 2; 3 4];
  B = [5 6; 7 8];
  disp(A * B);
end

function test_rectangular_matmul()
  % 2×3 * 3×4 → 2×4.
  A = [1 2 3; 4 5 6];
  B = [1 0 1 0; 0 1 0 1; 1 1 1 1];
  disp(A * B);
end

function test_chained_matmul()
  A = [1 2; 3 4];
  B = [0 1; 1 0];
  C = [5; 6];
  disp(A * B * C);
end

function test_scalar_mtimes_still_works()
  % Scalar * tensor and tensor * scalar route through elementwise
  % `times`. Confirms the scalar fast paths still fire.
  v = [1 2 3];
  disp(3 * v);
  disp(v * 4);
  disp(5 * 6);
end

function test_identity_like()
  % `I * M = M` and `M * I = M` for an identity 3×3.
  I = [1 0 0; 0 1 0; 0 0 1];
  M = [1 2 3; 4 5 6; 7 8 9];
  disp(I * M);
  disp(M * I);
end

function test_negative_signs()
  % Sign-mixing operand — result-sign falls back to `unknown`. Just
  % check the numeric output is correct.
  A = [1 -2; -3 4];
  B = [-1 1; 1 -1];
  disp(A * B);
end

function test_in_expression_position()
  % Matrix mul nested in larger expressions — must ANF and free
  % intermediate tensors correctly.
  A = [1 2; 3 4];
  B = [1 0; 0 1];
  disp((A * B) + A);
  disp(2 * (A * B));
end
