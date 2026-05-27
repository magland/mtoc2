test_feval_named_handle();
test_feval_anon_handle_var();
test_feval_no_args();
test_feval_char_name();
test_feval_multi_output();
test_feval_via_apply();
disp('SUCCESS');

function test_feval_named_handle()
  % feval with a named handle: feval(@helper, args...) ==
  % helper(args...).
  disp(feval(@sq, 4));
  disp(feval(@sq, 11));
  disp(feval(@inc, 7));
end

function test_feval_anon_handle_var()
  % feval with an anonymous handle bound to a variable.
  f = @(x) x * 2 + 1;
  disp(feval(f, 3));
  disp(feval(f, 10));
end

function test_feval_no_args()
  % feval on a 0-arg handle.
  g = @() 42;
  disp(feval(g));
end

function test_feval_char_name()
  % feval with a char-name: feval('helper', args...) routes to the
  % named function 'helper'.
  disp(feval('sq', 5));
  disp(feval('inc', 100));
end

function test_feval_multi_output()
  % Multi-output via feval on a multi-output target.
  [s, d] = feval(@sumdiff, 10, 3);
  disp(s);
  disp(d);
end

function test_feval_via_apply()
  % Pass feval-style indirection through an apply helper.
  disp(apply_feval(@sq, 6));
end

function y = sq(x)
  y = x * x;
end

function y = inc(x)
  y = x + 1;
end

function [s, d] = sumdiff(a, b)
  s = a + b;
  d = a - b;
end

function r = apply_feval(h, x)
  r = feval(h, x);
end
