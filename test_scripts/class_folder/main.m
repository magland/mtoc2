test_construct_with_args();
test_external_method_call();
test_two_external_methods();
test_method_calls_method();
test_property_write_then_external_method();
test_zero_arg_constructor_then_fill();

function test_construct_with_args()
  b = Box(3, 4);
  disp(b.w);
  disp(b.h);
end

function test_external_method_call()
  b = Box(3, 4);
  disp(b.area());
end

function test_two_external_methods()
  b = Box(2, 5);
  disp(b.area());
  disp(b.perimeter());
end

function test_method_calls_method()
  % `describe()` calls `area()` on the same receiver — exercises
  % method dispatch from inside an external method file.
  b = Box(3, 4);
  disp(b.describe());
end

function test_property_write_then_external_method()
  b = Box(1, 1);
  b.w = 7;
  b.h = 8;
  disp(b.area());
end

function test_zero_arg_constructor_then_fill()
  % EmptyBox has a no-arg constructor; callers fill the fields
  % afterwards. This is the shape chunkie_simple/@chunker uses.
  b = EmptyBox();
  b.w = 5;
  b.h = 6;
  disp(b.area());
end
