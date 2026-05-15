test_literals();
test_arithmetic();
test_division();
test_power();
test_unary_minus();
test_compare_eq_ne();
test_compare_rel();
test_if_cond();
test_while_cond();
test_through_func();

function test_literals()
  disp(1i);
  disp(2.5i);
  disp(0i);
  disp(1 + 0i);
  disp(0 + 1i);
  disp(1 + 2i);
  disp(3 - 4i);
end

function test_arithmetic()
  z = 1 + 2i;
  w = 3 - 4i;
  disp(z + w);
  disp(z - w);
  disp(w - z);
  disp(z * w);
  disp(z + 5);
  disp(5 - z);
  disp(2 * z);
  disp(z * 0);
  % Pure imaginary squared is real-negative.
  disp(2i * 2i);
end

function test_division()
  z = 1 + 2i;
  w = 3 + 4i;
  disp(z / w);
  disp(w / z);
  disp(z / 2);
  disp(2 / w);
end

function test_power()
  % Skip (1+1i)^2: the real-part artifact differs in tiny ulps between
  % JS's exp/log/sin/cos chain (numbl) and C's cpow (mtoc2). Both are
  % mathematically `0 + 2i`; both renderers show a tiny real residue
  % at different magnitudes. `2^(0+1i)` is well-conditioned and
  % matches across runners.
  disp((2)^(0+1i));
end

function test_unary_minus()
  z = 1 - 2i;
  disp(-z);
  disp(-(2i));
end

function test_compare_eq_ne()
  z = 1 + 2i;
  w = 1 + 2i;
  disp(z == w);
  disp(z == (1 - 2i));
  disp(z ~= (1 - 2i));
  % Real vs complex with zero imag: equal.
  disp((1 + 0i) == 1);
  disp(1 == (1 + 0i));
end

function test_compare_rel()
  % MATLAB compares on real part only for <, <=, >, >=.
  z = 1 + 5i;
  w = 2 - 3i;
  disp(z < w);
  disp(z > w);
  disp(z <= 1);
  disp(z >= 1);
end

function test_if_cond()
  if 1i
    disp(10);
  else
    disp(20);
  end
  if 0i
    disp(30);
  else
    disp(40);
  end
  z = 1 + 2i;
  %!numbl:opaque z
  if z
    disp(50);
  end
end

function test_while_cond()
  k = 0;
  z = 1 + 0i;
  %!numbl:opaque z
  while z
    k = k + 1;
    if k >= 3
      z = 0 + 0i;
    end
  end
  disp(k);
end

function test_through_func()
  z = 1 + 2i;
  disp(double_it(z));
end

function out = double_it(z)
  out = 2 * z;
end
