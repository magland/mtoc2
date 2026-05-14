test_range_assign();
test_range_step();
test_range_negative_step();
test_range_as_rhs_of_slice();
test_range_arithmetic();
test_range_empty();

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
