test_scalar_transpose();
test_row_to_col();
test_col_to_row();
test_matrix_square();
test_matrix_rect();
test_after_opaque_row();
test_after_opaque_col();
test_after_opaque_matrix();
test_chained();
test_transpose_then_arith();
test_transpose_in_func();
test_apostrophe_alias();
test_transpose_pass_to_func();

function test_scalar_transpose()
  disp(5.');
  disp((-3).');
  x = 7;
  disp(x.');
  y = 1.5;
  %!numbl:opaque y
  disp(y.');
end

function test_row_to_col()
  disp([1 2 3].');
  disp([1.5 -2 0.25].');
  disp([10 20 30 40].');
end

function test_col_to_row()
  disp([1; 2; 3].');
  disp([10; 20; 30; 40].');
end

function test_matrix_square()
  disp([1 2; 3 4].');
  disp([1.5 2; 3 4.5].');
end

function test_matrix_rect()
  disp([1 2 3; 4 5 6].');
  disp([1 2; 3 4; 5 6].');
end

function test_after_opaque_row()
  a = [1 2 3];
  %!numbl:opaque a
  disp(a.');
end

function test_after_opaque_col()
  a = [1; 2; 3];
  %!numbl:opaque a
  disp(a.');
end

function test_after_opaque_matrix()
  a = [1 2 3; 4 5 6];
  %!numbl:opaque a
  disp(a.');
end

function test_chained()
  % a.'.' should be a (two transposes cancel).
  a = [1 2 3];
  %!numbl:opaque a
  disp(a.'.');
  disp(a.'.'.');   % odd: same as a.'
end

function test_transpose_then_arith()
  a = [1 2 3];
  b = [10; 20; 30];
  %!numbl:opaque a b
  disp(a.' + b);     % both col vectors of length 3
  disp(b.' + a);     % both row vectors
end

function test_transpose_in_func()
  disp(make_col(11));
  disp(make_col(-5));
end

function test_apostrophe_alias()
  % For real tensors, `'` and `.'` produce the same result.
  a = [1 2 3];
  %!numbl:opaque a
  disp(a');
  disp(a.');
end

function test_transpose_pass_to_func()
  a = [1 2 3 4];
  %!numbl:opaque a
  disp(row_sum(a.'));
end

function v = make_col(x)
  v = [x x+1 x+2].';
end

function s = row_sum(v)
  s = sum(v);
end
