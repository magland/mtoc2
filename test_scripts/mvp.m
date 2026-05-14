test_arith_basic();
test_mul_div();
test_unary();
test_reassign();
test_if_else();
test_for_basic();
test_for_step();
test_while_basic();
test_func_basic();
test_func_with_if();
test_func_with_loop();
test_func_calls_func();

function test_arith_basic()
  x = 3;
  y = 4.5;
  z = x + y * 2;
  disp(z);
end

function test_mul_div()
  a = 12;
  b = 4;
  disp(a * b);
  disp(a / b);
  disp(a - b);
  disp(a + b);
end

function test_unary()
  x = 7;
  disp(-x);
  y = -3.5;
  disp(-y);
end

function test_reassign()
  x = 1;
  x = x + 1;
  x = x * 3;
  disp(x);
end

function test_if_else()
  x = 10;
  if x > 5
    disp(1);
  else
    disp(0);
  end

  y = -2;
  if y > 0
    disp(11);
  elseif y == 0
    disp(22);
  else
    disp(33);
  end
end

function test_for_basic()
  s = 0;
  for k = 1:10
    s = s + k;
  end
  disp(s);
end

function test_for_step()
  s = 0;
  for k = 0:2:10
    s = s + k;
  end
  disp(s);

  t = 0;
  for k = 10:-1:1
    t = t + k;
  end
  disp(t);
end

function test_while_basic()
  n = 10;
  s = 0;
  while n > 0
    s = s + n;
    n = n - 1;
  end
  disp(s);
end

function test_func_basic()
  disp(sq(5));
  disp(sq(2.5));
  disp(add(3, 4));
  disp(add(-1, 1));
end

function test_func_with_if()
  disp(clamp(5, 0, 10));
  disp(clamp(-3, 0, 10));
  disp(clamp(15, 0, 10));
  disp(abs2(-7));
  disp(abs2(7));
end

function test_func_with_loop()
  disp(fact(0));
  disp(fact(1));
  disp(fact(5));
  disp(triangular(100));
end

function test_func_calls_func()
  disp(square_then_double(3));
  disp(square_then_double(-4));
end

function y = sq(x)
  y = x * x;
end

function z = add(a, b)
  z = a + b;
end

function y = clamp(x, lo, hi)
  if x < lo
    y = lo;
  elseif x > hi
    y = hi;
  else
    y = x;
  end
end

function y = abs2(x)
  if x < 0
    y = -x;
  else
    y = x;
  end
end

function r = fact(n)
  r = 1;
  for k = 1:n
    r = r * k;
  end
end

function s = triangular(n)
  s = 0;
  for k = 1:n
    s = s + k;
  end
end

function y = double_it(x)
  y = 2 * x;
end

function y = square_then_double(x)
  y = double_it(sq(x));
end
