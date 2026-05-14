test_zeros_row_dyn();
test_zeros_col_dyn();
test_zeros_two_dyn();
test_ones_row_dyn();
test_zeros_square_dyn();
test_ones_square_dyn();
test_zeros_3d_dyn();
test_zeros_zero_dim();
test_reshape_form_a_dyn();
test_reshape_passthrough_dyn();

function test_zeros_row_dyn()
  k = 5;
  %!numbl:opaque k
  x = zeros(1, k);
  disp(x);
end

function test_zeros_col_dyn()
  n = 3;
  %!numbl:opaque n
  v = zeros(n, 1);
  disp(v);
end

function test_zeros_two_dyn()
  m = 2;
  n = 3;
  %!numbl:opaque m n
  disp(zeros(m, n));
end

function test_ones_row_dyn()
  k = 4;
  %!numbl:opaque k
  disp(ones(1, k));
end

function test_zeros_square_dyn()
  n = 3;
  %!numbl:opaque n
  disp(zeros(n));
end

function test_ones_square_dyn()
  n = 2;
  %!numbl:opaque n
  disp(ones(n));
end

function test_zeros_3d_dyn()
  a = 2;
  b = 3;
  c = 2;
  %!numbl:opaque a b c
  t = zeros(a, b, c);
  disp(numel(t));
end

function test_zeros_zero_dim()
  k = 0;
  %!numbl:opaque k
  v = zeros(1, k);
  disp(numel(v));
end

function test_reshape_form_a_dyn()
  rows = 2;
  cols = 3;
  %!numbl:opaque rows cols
  disp(reshape([1 2 3 4 5 6], rows, cols));
end

function test_reshape_passthrough_dyn()
  cols = 6;
  %!numbl:opaque cols
  disp(reshape([1 2 3 4 5 6], 1, cols));
end
