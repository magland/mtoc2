test_struct_outputs();
test_struct_with_tensor_field();

function test_struct_outputs()
  [s1, s2] = make_two_structs(3, 4);
  disp(s1.x);
  disp(s2.y);
end

function test_struct_with_tensor_field()
  [bag, total] = make_bag([1 2 3 4 5]);
  disp(bag.data);
  disp(total);
end

function [a, b] = make_two_structs(x, y)
  a = struct('x', x);
  b = struct('y', y);
end

function [b, t] = make_bag(d)
  b = struct('data', d);
  t = sum(d);
end
