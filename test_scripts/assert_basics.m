% assert is statement-only — no visible output on success. We
% interleave disp() calls so cross-runner parity exercises the
% "assert passed, next statement ran" property.

test_assert_exact_true();
test_assert_exact_compare();
test_assert_runtime_true();
test_assert_with_msg();
test_assert_in_function();
test_assert_in_loop();
test_assert_fmt();

function test_assert_exact_true()
  assert(1);
  assert(2 + 3 == 5);
  assert(7 > 0);
  disp(1);
end

function test_assert_exact_compare()
  % Comparison transfer is folded — the assert should be a no-op at codegen.
  assert(10 > 5);
  assert(5 >= 5);
  assert(3 ~= 4);
  disp(2);
end

function test_assert_runtime_true()
  x = 5;
  %!numbl:opaque x
  assert(x > 0);
  assert(x ~= 0);
  disp(3);
end

function test_assert_with_msg()
  x = 7;
  %!numbl:opaque x
  assert(x >= 0, 'x must be non-negative');
  assert(x == 7, 'x should equal seven');
  disp(4);
end

function test_assert_in_function()
  disp(helper(5));
  disp(helper(0));
end

function y = helper(n)
  assert(n >= 0, 'n must be non-negative');
  y = n * 2;
end

function test_assert_in_loop()
  s = 0;
  for k = 1:5
    assert(k > 0);
    s = s + k;
  end
  disp(s);
end

function test_assert_fmt()
  % All conds truthy → no runtime failure; cross-runner sees identical
  % empty stderr on both sides.

  % Bare assertion.
  assert(1);
  assert(2 > 1);

  % Literal message.
  assert(3 > 2, 'three is greater');

  % printf-style message (cond is truthy, but the code path compiles).
  n = 5;
  assert(n > 0, 'expected positive n, got %d', n);

  % printf-style with multiple args.
  a = 1.5;
  b = 2.5;
  assert(a < b, 'a=%.1f, b=%.1f', a, b);

  % Opaque message var (no exact at compile time).
  flag = 1;
  msg = 'dynamic message';
  if flag > 0
    assert(1, msg);
  end

  disp('done');
end
