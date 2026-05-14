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
