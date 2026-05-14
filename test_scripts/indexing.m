% Indexing & slicing — scalar reads/writes, range/colon slice reads/writes,
% range-as-value, end keyword, loop-body widening, post-write exact refresh,
% and indexed-write sign widening.

test_index_read_2d();
test_index_read_3d();
test_index_read_linear();
test_index_write_2d();
test_index_write_3d();
test_index_write_then_read();
test_index_end_linear();
test_index_end_perdim();
test_index_in_loop();

test_slice_read_colon_linear();
test_slice_read_range_linear();
test_slice_read_perdim_colon();
test_slice_read_perdim_range();
test_slice_read_perdim_mixed();
test_slice_read_3d_page();
test_slice_write_colon();
test_slice_write_range_scalar_rhs();
test_slice_write_range_var_rhs();
test_slice_write_perdim();
test_slice_write_3d_page_var_rhs();
test_slice_with_end();
test_slice_write_then_read();

test_range_assign();
test_range_step();
test_range_negative_step();
test_range_as_rhs_of_slice();
test_range_arithmetic();
test_range_empty();

test_scalar_write_invalidates_sum();
test_slice_write_invalidates_sum();
test_scalar_write_invalidates_disp();

test_index_write_in_for_strips_exact();
test_slice_write_in_for_strips_exact();
test_index_write_in_while_strips_exact();

test_indexed_write_widens_sign();

% -------- scalar index --------

function test_index_read_2d()
  m = zeros(2, 3);
  m(1, 1) = 1;
  m(2, 1) = 2;
  m(1, 2) = 3;
  m(2, 2) = 4;
  m(1, 3) = 5;
  m(2, 3) = 6;
  disp(m(1, 1));
  disp(m(2, 1));
  disp(m(1, 2));
  disp(m(2, 3));
end

function test_index_read_3d()
  t = zeros(2, 3, 4);
  t(1, 2, 3) = 7;
  t(2, 3, 4) = 9;
  disp(t(1, 2, 3));
  disp(t(2, 3, 4));
  disp(t(1, 1, 1));
end

function test_index_read_linear()
  m = zeros(2, 3);
  m(2, 1) = 100;
  m(1, 2) = 200;
  m(2, 3) = 300;
  % column-major: linear index 1 -> (1,1), 2 -> (2,1), 3 -> (1,2), ...
  disp(m(1));
  disp(m(2));
  disp(m(3));
  disp(m(6));
end

function test_index_write_2d()
  m = zeros(3, 3);
  for k = 1:3
    m(k, k) = k;
  end
  disp(m);
end

function test_index_write_3d()
  t = zeros(2, 2, 2);
  t(1, 1, 1) = 1;
  t(2, 2, 2) = 8;
  t(1, 2, 1) = 3;
  disp(t);
end

function test_index_write_then_read()
  v = zeros(1, 5);
  v(3) = 42;
  disp(v(3));
  v(3) = v(3) + 1;
  disp(v(3));
end

function test_index_end_linear()
  v = zeros(1, 5);
  v(5) = 99;
  v(4) = 88;
  disp(v(end));
  disp(v(end - 1));
end

function test_index_end_perdim()
  m = zeros(3, 4);
  m(3, 4) = 12;
  m(3, 2) = 5;
  disp(m(end, end));
  disp(m(end, 2));
end

function test_index_in_loop()
  v = zeros(1, 5);
  for k = 1:5
    v(1, k) = k * 10;
  end
  disp(v);
end

% -------- slice index --------

function test_slice_read_colon_linear()
  m = zeros(2, 3);
  m(1, 1) = 1; m(2, 1) = 2;
  m(1, 2) = 3; m(2, 2) = 4;
  m(1, 3) = 5; m(2, 3) = 6;
  v = m(:);
  disp(v);
end

function test_slice_read_range_linear()
  v = zeros(1, 6);
  for k = 1:6
    v(k) = k * 10;
  end
  w = v(2:5);
  disp(w);
end

function test_slice_read_perdim_colon()
  m = zeros(3, 4);
  for r = 1:3
    for c = 1:4
      m(r, c) = r + c * 10;
    end
  end
  col2 = m(:, 2);
  disp(col2);
  row3 = m(3, :);
  disp(row3);
end

function test_slice_read_perdim_range()
  m = zeros(4, 4);
  for r = 1:4
    for c = 1:4
      m(r, c) = r + c * 10;
    end
  end
  sub = m(2:3, 2:3);
  disp(sub);
end

function test_slice_read_perdim_mixed()
  t = zeros(2, 3, 4);
  for i = 1:2
    for j = 1:3
      for k = 1:4
        t(i, j, k) = i * 100 + j * 10 + k;
      end
    end
  end
  slice = t(:, 2, :);
  disp(slice);
end

function test_slice_read_3d_page()
  t = zeros(2, 3, 4);
  for i = 1:2
    for j = 1:3
      for k = 1:4
        t(i, j, k) = i + j * 10 + k * 100;
      end
    end
  end
  page = t(:, :, 2);
  disp(page);
end

function test_slice_write_colon()
  v = zeros(1, 4);
  v(:) = 7;
  disp(v);
end

function test_slice_write_range_scalar_rhs()
  v = zeros(1, 6);
  v(2:5) = 9;
  disp(v);
end

function test_slice_write_range_var_rhs()
  v = zeros(1, 6);
  w = zeros(1, 4);
  for k = 1:4
    w(k) = k;
  end
  v(2:5) = w;
  disp(v);
end

function test_slice_write_perdim()
  m = zeros(3, 3);
  m(2, :) = 5;
  disp(m);
end

function test_slice_write_3d_page_var_rhs()
  t = zeros(2, 3, 4);
  page = zeros(2, 3);
  for r = 1:2
    for c = 1:3
      page(r, c) = r + c * 10;
    end
  end
  t(:, :, 2) = page;
  disp(t);
end

function test_slice_with_end()
  v = zeros(1, 6);
  for k = 1:6
    v(k) = k;
  end
  w = v(2:end);
  disp(w);
  x = v(1:end - 1);
  disp(x);
end

function test_slice_write_then_read()
  v = zeros(1, 5);
  v(2:4) = 8;
  w = v(2:4);
  disp(w);
end

% -------- range as value --------

function test_range_assign()
  v = 1:5;
  disp(v);
end

function test_range_step()
  v = 1:2:10;
  disp(v);
end

function test_range_negative_step()
  v = 10:-1:1;
  disp(v);
end

function test_range_as_rhs_of_slice()
  n = 4;
  adjs = zeros(1, n);
  adjs(1, 1:n) = 0:(n - 1);
  disp(adjs);
end

function test_range_arithmetic()
  v = (1:5) * 2;
  disp(v);
end

function test_range_empty()
  v = 5:1;
  disp(numel(v));
end

% -------- post-indexed-write exact refresh --------

function test_scalar_write_invalidates_sum()
  x = zeros(1, 4);
  x(1) = 5;
  if sum(x) > 0
    disp(11);
  else
    disp(22);
  end
end

function test_slice_write_invalidates_sum()
  x = zeros(1, 4);
  x(2:3) = [7 8];
  if sum(x) > 10
    disp(33);
  else
    disp(44);
  end
end

function test_scalar_write_invalidates_disp()
  x = ones(1, 3);
  x(2) = 99;
  disp(x);
end

% -------- loop-body widening on indexed writes --------

function test_index_write_in_for_strips_exact()
  x = zeros(1, 4);
  for k = 1:4
    if sum(x) > 5
      disp(101);
    else
      disp(202);
    end
    x(k) = k;
  end
end

function test_slice_write_in_for_strips_exact()
  x = zeros(1, 4);
  for k = 1:2
    if sum(x) > 5
      disp(303);
    else
      disp(404);
    end
    x(2*k - 1 : 2*k) = [10 20];
  end
end

function test_index_write_in_while_strips_exact()
  x = zeros(1, 3);
  k = 1;
  while k <= 3
    if sum(x) > 5
      disp(505);
    else
      disp(606);
    end
    x(k) = 100;
    k = k + 1;
  end
end

% -------- indexed-write sign widening --------

function test_indexed_write_widens_sign()
  x = zeros(1, 5);
  x(3) = 4;
  disp(sqrt(x));

  y = zeros(1, 5);
  y(2:3) = [9 16];
  disp(sqrt(y));
end
