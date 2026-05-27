test_cell_literal_basic();
test_cell_literal_mixed();
test_cell_constructor_1arg();
test_cell_constructor_2arg();
test_cell_nested_literal();
test_cell_disp_with_tensor();
test_iscell_yes();
test_iscell_no();
test_cell_brace_read_literal();
test_cell_brace_read_2d();
test_cell_brace_write_tensor_slots();
test_cell_brace_write_then_read();

function test_cell_literal_basic()
  c = {1, 2, 3};
  disp(c);
end

function test_cell_literal_mixed()
  c = {1, 'hi', "world"};
  disp(c);
end

function test_cell_constructor_1arg()
  c = cell(2);
  disp(c);
end

function test_cell_constructor_2arg()
  c = cell(1, 3);
  disp(c);
end

function test_cell_nested_literal()
  c = {{1, 2}, {3}};
  disp(c);
end

function test_cell_disp_with_tensor()
  c = {1, [1 2 3]};
  disp(c);
end

function test_iscell_yes()
  c = {1, 2};
  disp(iscell(c));
end

function test_iscell_no()
  disp(iscell(5));
  disp(iscell([1 2 3]));
  disp(iscell('hi'));
end

function test_cell_brace_read_literal()
  c = {10, 20, 30};
  disp(c{1});
  disp(c{2});
  disp(c{3});
end

function test_cell_brace_read_2d()
  c = {1, 2; 3, 4};
  disp(c{1, 1});
  disp(c{2, 1});
  disp(c{1, 2});
  disp(c{2, 2});
end

function test_cell_brace_write_tensor_slots()
  out = cell(2, 1);
  out{1} = [1; 2];
  out{2} = [3; 4];
  disp(out{1});
  disp(out{2});
end

function test_cell_brace_write_then_read()
  out = cell(3, 1);
  out{1} = [1 2 3];
  out{2} = [4 5 6];
  out{3} = [7 8 9];
  s = out{1} + out{2} + out{3};
  disp(s);
end
