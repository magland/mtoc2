test_flipud_row();
test_flipud_col();
test_flipud_matrix();
test_fliplr_row();
test_fliplr_col();
test_fliplr_matrix();
test_flip_default_row();
test_flip_default_col();
test_flip_default_matrix();
test_flip_dim_explicit();
test_flip_scalar_passthrough();
test_flip_after_opaque();
test_flipud_then_fliplr();

function test_flipud_row()
  % flipud on a row is identity (only one row).
  disp(flipud([1 2 3]));
end

function test_flipud_col()
  disp(flipud([1; 2; 3; 4]));
  disp(flipud([10; -20; 30]));
end

function test_flipud_matrix()
  disp(flipud([1 2; 3 4]));
  disp(flipud([1 2 3; 4 5 6; 7 8 9]));
end

function test_fliplr_row()
  disp(fliplr([1 2 3 4]));
  disp(fliplr([10 -20 30]));
end

function test_fliplr_col()
  % fliplr on a col is identity.
  disp(fliplr([1; 2; 3]));
end

function test_fliplr_matrix()
  disp(fliplr([1 2; 3 4]));
  disp(fliplr([1 2 3; 4 5 6]));
end

function test_flip_default_row()
  % `flip(A)` flips along the first non-singleton axis. For a row
  % vector that's axis 2 (cols).
  disp(flip([1 2 3 4]));
end

function test_flip_default_col()
  disp(flip([1; 2; 3]));
end

function test_flip_default_matrix()
  % For a 2-D matrix the first non-singleton axis is axis 1 (rows).
  disp(flip([1 2; 3 4]));
end

function test_flip_dim_explicit()
  disp(flip([1 2; 3 4], 1));
  disp(flip([1 2; 3 4], 2));
end

function test_flip_scalar_passthrough()
  disp(flipud(7));
  disp(fliplr(-3));
  disp(flip(1.5));
end

function test_flip_after_opaque()
  a = [1 2 3; 4 5 6];
  %!numbl:opaque a
  disp(flipud(a));
  disp(fliplr(a));
  disp(flip(a, 1));
  disp(flip(a, 2));
end

function test_flipud_then_fliplr()
  a = [1 2 3; 4 5 6];
  disp(fliplr(flipud(a)));
end
