test_double_numeric_scalar();
test_double_logical_scalar();
test_double_real_tensor();
test_double_logical_tensor();
test_double_char_literal();
test_class_numeric();
test_class_logical();
test_class_char();
test_class_string();
test_class_struct();
test_class_cell();
test_class_handle();
disp('SUCCESS');

function test_double_numeric_scalar()
  x = 3.5;
  disp(double(x));
  disp(double(-2));
  disp(double(0));
end

function test_double_logical_scalar()
  disp(double(true));
  disp(double(false));
  % Comparison result (numeric 0/1 in mtoc2 / numbl interpreter) is
  % already numeric — double() is identity. Force the lattice into
  % `logical` for the typed path.
  t = true;
  disp(double(t));
end

function test_double_real_tensor()
  v = [1.5, 2.5, 3.5];
  d = double(v);
  disp(d);
  disp(isequal(d, v));
end

function test_double_logical_tensor()
  m = logical([1, 0, 1]);
  d = double(m);
  disp(d);
end

function test_double_char_literal()
  disp(double('A'));
  disp(double('foo'));
  disp(double('Hi!'));
end

function test_class_numeric()
  disp(class(3.5));
  disp(class(-2));
  disp(class([1, 2, 3]));
  disp(class(zeros(2, 3)));
end

function test_class_logical()
  disp(class(true));
  disp(class(false));
end

function test_class_char()
  disp(class('hello'));
  disp(class('A'));
end

function test_class_string()
  disp(class("hello"));
end

function test_class_struct()
  s = struct('a', 1, 'b', 2);
  disp(class(s));
end

function test_class_cell()
  c = {1, 'two', 3.5};
  disp(class(c));
end

function test_class_handle()
  h = @(x) x + 1;
  disp(class(h));
end
