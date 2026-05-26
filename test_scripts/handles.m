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
test_tensor_capture_basic();
test_tensor_capture_snapshot();
test_tensor_capture_factory();
test_tensor_capture_in_loop();
test_struct_capture();
test_class_capture();
test_handle_of_handle_with_tensor();
test_named_handle_multi_out();
test_named_handle_multi_truncated_to_one();
test_named_handle_multi_with_discard();
test_named_handle_multi_drop_all();
test_named_handle_multi_via_capture();

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

function test_tensor_capture_basic()
  % Capture a tensor; body reads it via a builtin.
  v = [1 2 3 4];
  f = @(x) sum(v) + x;
  disp(f(0));
  disp(f(100));
end

function test_tensor_capture_snapshot()
  % MATLAB by-value capture: rebinding `v` after `f` is built must
  % not affect what the handle sees.
  v = [1 2 3];
  f = @() sum(v);
  v = [100 200];
  disp(f());
end

function test_tensor_capture_factory()
  % Factory returns a handle whose capture is a tensor — the
  % returned handle owns its capture buffer across the call boundary.
  f = make_dot([1 2 3 4]);
  disp(f(1));
  disp(f(2));
end

function test_tensor_capture_in_loop()
  % Build, call, and drop a tensor-capturing handle every iteration.
  % Exercises the scope-exit / early-free path for owned-typed handles
  % under reassignment.
  total = 0;
  for k = 1:4
    v = [k k+1 k+2];
    f = @() sum(v);
    total = total + f();
  end
  disp(total);
end

function test_struct_capture()
  s = struct('a', 5, 'b', 11);
  f = @(x) s.a * x + s.b;
  disp(f(0));
  disp(f(3));
end

function test_class_capture()
  % Capture a class instance and read a property in the body.
  p = HandlePoint(3, 4);
  f = @() p.x + p.y;
  disp(f());
end

function test_handle_of_handle_with_tensor()
  % Two-level capture: inner handle captures a tensor; outer handle
  % captures the inner handle (so the outer's typedef references the
  % inner's). Each `disp` materializes the whole chain.
  v = [10 20 30];
  g = @() sum(v);
  f = @(x) g() + x;
  disp(f(1));
  disp(f(2));
end

function y = sq(x); y = x * x; end
function y = inc(x); y = x + 1; end
function y = dec(x); y = x - 1; end

function [a, b] = swap(x, y)
  a = y;
  b = x;
end

function [s, d, p] = three_returns(x, y)
  s = x + y;
  d = x - y;
  p = x * y;
end

function test_named_handle_multi_out()
  % Direct [a, b] = h(x, y) on a named handle to a multi-output
  % function. mtoc2's lowerer used to reject this; should now
  % specialize and dispatch via MultiAssignCall.
  h = @swap;
  [a, b] = h(1, 2);
  disp(a);
  disp(b);
end

function test_named_handle_multi_truncated_to_one()
  % Single-output call site on a handle whose target declares
  % multiple outputs — the spec truncates to nargout=1 and we get
  % the first output.
  h = @three_returns;
  s = h(10, 3);
  disp(s);
end

function test_named_handle_multi_with_discard()
  % Discard the middle slot via `~`, and use a trailing-omitted
  % slot (nargout=2 on a 3-output target).
  h = @three_returns;
  [s, ~] = h(10, 3);
  disp(s);
end

function test_named_handle_multi_drop_all()
  % Bare-statement use of a multi-output handle call: nargout=0,
  % no lvalues. Same shape as `helper(x);` for a named user fn.
  h = @three_returns;
  h(2, 5);
  disp(0);
end

function test_named_handle_multi_via_capture()
  % Handle captured by an anonymous wrapper, then called multi-
  % output. Exercises the capture + multi-out paths together.
  k = @swap;
  [u, v] = k(7, 9);
  disp(u);
  disp(v);
end

function r = apply(h, x)
  r = h(x);
end

function h = make_adder(k)
  h = @(x) x + k;
end

function h = make_dot(v)
  h = @(k) sum(v) * k;
end

classdef HandlePoint
  properties
    x = 0
    y = 0
  end
  methods
    function obj = HandlePoint(x, y)
      obj.x = x;
      obj.y = y;
    end
  end
end
