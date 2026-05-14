test_index_read_2d();
test_index_read_3d();
test_index_read_linear();
test_index_write_2d();
test_index_write_3d();
test_index_write_then_read();
test_index_end_linear();
test_index_end_perdim();
test_index_in_loop();

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
