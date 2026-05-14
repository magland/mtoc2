test_or_basic();
test_and_basic();
test_or_fold_exact();
test_and_fold_exact();
test_short_circuit_lhs_truthy_or();
test_short_circuit_lhs_falsy_and();
test_not_scalar();
test_not_scalar_runtime();
test_not_tensor_row();
test_not_tensor_col();
test_not_tensor_matrix();
test_not_after_opaque();
test_in_if_cond();
test_in_while_cond();
test_chained_logical();
test_not_pass_to_func();

function test_or_basic()
  disp(1 || 0);
  disp(0 || 1);
  disp(0 || 0);
  disp(1 || 1);
end

function test_and_basic()
  disp(1 && 0);
  disp(0 && 1);
  disp(0 && 0);
  disp(1 && 1);
end

function test_or_fold_exact()
  % Exact-known both sides fold at compile time. Spot-check a few.
  disp(3 > 0 || 5 < 0);
  disp(3 > 0 || 5 > 0);
end

function test_and_fold_exact()
  disp(3 > 0 && 5 < 0);
  disp(3 > 0 && 5 > 0);
end

function test_short_circuit_lhs_truthy_or()
  % Hand-rolled "if exact-truthy LHS, fold to true regardless of RHS".
  a = 1;
  b = 0;
  disp(a || b);
end

function test_short_circuit_lhs_falsy_and()
  a = 0;
  b = 1;
  disp(a && b);
end

function test_not_scalar()
  disp(~5);
  disp(~0);
  disp(~-3);
  disp(~1.5);
end

function test_not_scalar_runtime()
  x = 7;
  %!numbl:opaque x
  disp(~x);
  y = 0;
  %!numbl:opaque y
  disp(~y);
end

function test_not_tensor_row()
  disp(~[1 0 -2 0]);
  disp(~[0 0 0]);
  disp(~[1 2 3]);
end

function test_not_tensor_col()
  disp(~[1; 0; -2; 0]);
end

function test_not_tensor_matrix()
  disp(~[1 0; 0 1]);
  disp(~[1 -1 0; 0 2 3]);
end

function test_not_after_opaque()
  a = [1 0 -2 0];
  %!numbl:opaque a
  disp(~a);

  b = [0 0 0; 0 0 0];
  %!numbl:opaque b
  disp(~b);
end

function test_in_if_cond()
  x = 5;
  y = 10;
  if x > 0 && y > 0
    disp(1);
  else
    disp(0);
  end
  if x < 0 || y > 0
    disp(11);
  else
    disp(22);
  end
end

function test_in_while_cond()
  n = 3;
  s = 0;
  while n > 0 && s < 100
    s = s + n;
    n = n - 1;
  end
  disp(s);
end

function test_chained_logical()
  % Multiple || / && chains.
  disp(1 || 0 || 0);
  disp(0 || 0 || 1);
  disp(1 && 1 && 1);
  disp(1 && 0 && 1);
end

function test_not_pass_to_func()
  a = [1 0 -2 0];
  %!numbl:opaque a
  disp(count_nonzero(a));
end

function s = count_nonzero(v)
  % sum(~~v) counts the truthy entries of v. We use ~~ to map nonzero → 1.
  s = sum(~~v);
end
