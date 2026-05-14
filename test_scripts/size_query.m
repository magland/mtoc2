test_size_scalar();
test_size_row_vec();
test_size_col_vec();
test_size_matrix();
test_size_3d();
test_size_with_dim();
test_size_with_dim_oversized();
test_size_after_opaque();
test_size_dim_dynamic();
test_size_in_zeros();
test_size_in_ones();
test_size_with_concat();

function test_size_scalar()
  disp(size(5));
  disp(size(0));
  disp(size(-3.5));
end

function test_size_row_vec()
  disp(size([1 2 3]));
  disp(size([10 20 30 40 50]));
end

function test_size_col_vec()
  disp(size([1; 2; 3]));
  disp(size([10; 20; 30; 40]));
end

function test_size_matrix()
  disp(size([1 2; 3 4]));
  disp(size([1 2 3; 4 5 6]));
end

function test_size_3d()
  disp(size(zeros(2, 3, 4)));
  disp(size(ones(5, 2, 7)));
end

function test_size_with_dim()
  disp(size([1 2 3; 4 5 6], 1));
  disp(size([1 2 3; 4 5 6], 2));
  disp(size(zeros(2, 3, 4), 1));
  disp(size(zeros(2, 3, 4), 2));
  disp(size(zeros(2, 3, 4), 3));
end

function test_size_with_dim_oversized()
  % size(A, k) returns 1 when k > ndim (MATLAB semantics).
  disp(size([1 2 3], 5));
  disp(size(zeros(2, 3), 4));
end

function test_size_after_opaque()
  a = [1 2 3 4];
  %!numbl:opaque a
  disp(size(a));
  disp(size(a, 1));
  disp(size(a, 2));
end

function test_size_dim_dynamic()
  a = [1 2 3; 4 5 6];
  %!numbl:opaque a
  k = 1;
  %!numbl:opaque k
  disp(size(a, k));
  k = 2;
  %!numbl:opaque k
  disp(size(a, k));
end

function test_size_in_zeros()
  disp(zeros(size([1 2 3])));
  disp(zeros(size([1 2; 3 4])));
end

function test_size_in_ones()
  disp(ones(size([1 2 3 4])));
  disp(ones(size([1; 2; 3])));
end

function test_size_with_concat()
  % [n+1, size(xs)] is a row vector that reshape can read.
  xs = [1 2 3 4];
  szx = size(xs);
  disp(szx);
  disp([1, szx]);
end
