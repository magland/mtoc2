% mtoc2-test-xfail-c-aot: try/catch is interpreter-only in mtoc2; AOT raises UnsupportedConstruct at lowering
% mtoc2-test-xfail-js-aot: try/catch is interpreter-only in mtoc2; AOT raises UnsupportedConstruct at lowering

test_try_catch_basic_id();
test_try_catch_bare_message();
test_try_catch_no_var();
test_try_no_catch();
test_try_catch_nested();
test_try_in_function();
test_warning_does_not_throw();

function test_try_catch_basic_id()
  try
    error('topic:bad', 'index %d out of range', 7);
  catch ME
    disp(ME.identifier);
    disp(ME.message);
  end
end

function test_try_catch_bare_message()
  try
    error('something failed');
  catch ME
    disp(ME.identifier);
    disp(ME.message);
  end
end

function test_try_catch_no_var()
  try
    error('this should be swallowed');
  catch
    disp('caught');
  end
end

function test_try_no_catch()
  try
    error('this should also be swallowed');
  end
  disp('after');
end

function test_try_catch_nested()
  try
    try
      error('inner:err', 'inner error');
    catch ME
      disp(ME.identifier);
      error('outer:err', 'rethrown as outer');
    end
  catch ME2
    disp(ME2.identifier);
    disp(ME2.message);
  end
end

function test_try_in_function()
  v = compute_with_fallback(7);
  disp(v);
  v = compute_with_fallback(-1);
  disp(v);
end

function y = compute_with_fallback(x)
  try
    if x < 0
      error('arg:negative', 'x must be >= 0');
    end
    y = sqrt(x);
  catch
    y = 0;
  end
end

function test_warning_does_not_throw()
  % Warnings should print but NOT propagate through try/catch —
  % the catch body should not execute.
  fired = 0;
  try
    warning('this should print but not throw');
    fired = 1;
  catch
    fired = 99;
  end
  disp(fired);
end
