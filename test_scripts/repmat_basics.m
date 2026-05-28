% repmat: replicate and tile arrays. Covers the three surface forms
% (single scalar rep, multi-scalar reps, vector reps) plus scalar /
% vector / matrix inputs and the runtime-dim (opaque) case.

function repmat_basics()
  test_scalar_input_square();
  test_scalar_input_rect();
  test_scalar_input_vector_form();
  test_row_vector_tile();
  test_col_vector_tile();
  test_matrix_square_tile();
  test_matrix_rect_tile();
  test_vector_form();
  test_all_ones();
  test_opaque_dim();
  test_opaque_rect_dim();
  test_repmat_trailing_singleton();
  disp('SUCCESS');
end

function test_scalar_input_square()
  disp(repmat(7, 3));
end

function test_scalar_input_rect()
  disp(repmat(5, 2, 4));
end

function test_scalar_input_vector_form()
  disp(repmat(2, [3, 2]));
end

function test_row_vector_tile()
  disp(repmat([1 2 3], 2, 2));
end

function test_col_vector_tile()
  disp(repmat([10; 20; 30], 1, 3));
end

function test_matrix_square_tile()
  disp(repmat([1 2; 3 4], 2));
end

function test_matrix_rect_tile()
  disp(repmat([1 2 3; 4 5 6], 2, 3));
end

function test_vector_form()
  disp(repmat([1 2; 3 4], [3, 2]));
end

function test_all_ones()
  disp(repmat([1 2 3; 4 5 6], 1, 1));
end

function test_opaque_dim()
  n = 3;
  %!numbl:opaque n
  disp(repmat([1 2; 3 4], n));
end

function test_opaque_rect_dim()
  m = 2;
  n = 3;
  %!numbl:opaque m
  %!numbl:opaque n
  disp(repmat([1; 2], m, n));
end

function test_repmat_trailing_singleton()
  % Per numbl/MATLAB: repmat trims trailing singleton dims back to
  % the 2-axis floor. `repmat([1 2 3], 1, 1, 1)` is 2-D [1×3], NOT
  % 3-D [1×3×1]. Same applies to scalar inputs.
  a = [1 2 3];
  b = repmat(a, 1, 1, 1);
  disp(ndims(b));
  disp(size(b));
  c = repmat(5, 1, 1, 1);
  disp(ndims(c));
  disp(size(c));
  d = repmat([1 2; 3 4], 2, 1, 1);
  disp(ndims(d));
  disp(size(d));
end
