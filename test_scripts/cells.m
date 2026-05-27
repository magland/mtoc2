test_cell_literal_basic();
test_cell_literal_mixed();
test_cell_constructor_1arg();
test_cell_constructor_2arg();
test_cell_nested_literal();
test_cell_disp_with_tensor();
test_iscell_yes();
test_iscell_no();

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
