function diag_basics()
  test_construct_row();
  test_construct_col();
  test_extract_square();
  test_extract_tall();
  test_extract_wide();
  test_construct_with_k_pos();
  test_construct_with_k_neg();
  test_extract_with_k_pos();
  test_extract_with_k_neg();
  test_scalar_passthrough();
  test_scalar_with_k();
  test_after_opaque();
  disp('SUCCESS');
end

function test_construct_row()
  disp(diag([1 2 3]));
end

function test_construct_col()
  disp(diag([10; 20; 30; 40]));
end

function test_extract_square()
  disp(diag([1 2 3; 4 5 6; 7 8 9]));
end

function test_extract_tall()
  % 3x2 matrix → min(3,2)=2 column vector
  disp(diag([1 2; 3 4; 5 6]));
end

function test_extract_wide()
  % 2x4 matrix → min(2,4)=2 column vector
  disp(diag([1 2 3 4; 5 6 7 8]));
end

function test_construct_with_k_pos()
  % Row vector + k=1 → 4x4 matrix with values on the superdiagonal
  disp(diag([1 2 3], 1));
end

function test_construct_with_k_neg()
  % Col vector + k=-2 → 5x5 matrix with values on the subdiagonal
  disp(diag([7; 8; 9], -2));
end

function test_extract_with_k_pos()
  % 3x3 matrix, k=1 → 2-element column from superdiagonal
  disp(diag([1 2 3; 4 5 6; 7 8 9], 1));
end

function test_extract_with_k_neg()
  % 3x3 matrix, k=-1 → 2-element column from subdiagonal
  disp(diag([1 2 3; 4 5 6; 7 8 9], -1));
end

function test_scalar_passthrough()
  disp(diag(7));
end

function test_scalar_with_k()
  % Scalar + k=2 → 3x3 with the scalar at (0,2)
  disp(diag(5, 2));
end

function test_after_opaque()
  v = [1 2 3 4];
  %!numbl:opaque v
  disp(diag(v));
  a = [1 2 3; 4 5 6; 7 8 9];
  %!numbl:opaque a
  disp(diag(a));
  disp(diag(a, 1));
  disp(diag(a, -1));
end
