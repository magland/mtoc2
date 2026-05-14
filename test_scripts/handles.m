test_named_handle_basic();
test_named_handle_via_apply();
test_named_handle_two_targets_distinct_specs();
test_anon_no_capture();
test_anon_scalar_capture();
test_anon_two_captures();
test_anon_inline_arg();
test_factory_returning_handle();
test_anon_body_calls_captured_handle();
test_handle_in_loop_accumulator();
test_handle_runtime_capture();

function test_named_handle_basic()
  f = @sq;
  disp(f(3));
  disp(f(10));
end

function test_named_handle_via_apply()
  disp(apply(@sq, 5));
  disp(apply(@inc, 5));
end

function test_named_handle_two_targets_distinct_specs()
  % apply() specializes per-handle-target; both calls compile to
  % distinct apply__<hex> functions in the emitted C.
  disp(apply(@inc, 7));
  disp(apply(@dec, 7));
end

function test_anon_no_capture()
  f = @(x) x * 2;
  disp(f(5));
  disp(f(0));
  disp(f(-3));
end

function test_anon_scalar_capture()
  k = 5;
  f = @(x) x + k;
  disp(f(3));
  disp(f(10));
end

function test_anon_two_captures()
  a = 2;
  b = 7;
  f = @(x) a * x + b;
  disp(f(0));
  disp(f(3));
end

function test_anon_inline_arg()
  disp(apply(@(x) x * x + 1, 4));
  m = 11;
  disp(apply(@(x) x + m, 9));
end

function test_factory_returning_handle()
  f = make_adder(7);
  disp(f(3));
  disp(f(100));

  g = make_adder(-1);
  disp(g(5));
end

function test_anon_body_calls_captured_handle()
  g = @sq;
  f = @(x) g(x) + 1;
  disp(f(4));
  disp(f(5));
end

function test_handle_in_loop_accumulator()
  f = @(x) x * x;
  total = 0;
  for k = 1:5
    total = total + f(k);
  end
  disp(total);
end

function test_handle_runtime_capture()
  % Capture from a runtime-only (opaque) source so the handle's
  % field carries a true runtime value, not a folded constant.
  k = 3;
  %!numbl:opaque k
  f = @(x) x + k;
  disp(f(1));
  disp(f(2));
end

function y = sq(x); y = x * x; end
function y = inc(x); y = x + 1; end
function y = dec(x); y = x - 1; end

function r = apply(h, x)
  r = h(x);
end

function h = make_adder(k)
  h = @(x) x + k;
end
