test_func_if_fold_on_arg();
test_multi_output_swap();
test_multi_output_partial_consume();
test_multi_output_ignore();
test_multi_output_drop_all();
test_recursive_call();
test_recursive_call_runtime_arg();
test_recursive_call_in_loop();
test_void_function_in_expr_stmt();
test_fewer_args_nargin_then();
test_fewer_args_nargin_else();
test_fewer_args_zero();
test_fewer_args_many();

function test_func_if_fold_on_arg()
  % Regression: a user function whose `if` cond is a comparison on
  % exact-known params should fold to one arm. Before the
  % `foldedLiteralFromType` fix, comparison transfers returned a
  % scalarLogical-with-exact that wasn't recognized as foldable, so
  % both arms emitted in the specialized helper.

  cc = 3;
  a = helper(cc, 1);
  b = helper(a, 2);
  disp(a);
  disp(b);
end

function y = helper(x, opt)
  if opt == 1
    y = x + 1;
  else
    y = x + 2;
  end
end

function test_multi_output_swap()
  % Two-output user function via `[a, b] = swap(x, y)`. The callee's
  % C ABI is `void swap__<hex>(double x, double y, double *_mtoc2_o0,
  % double *_mtoc2_o1)`; the call site wraps in `{ ... }` and passes
  % &a, &b.
  [a, b] = swap(10, 20);
  disp(a);
  disp(b);
  % Same callee, different arg values → distinct specialization key
  % (exact-value tracking through the type system).
  [c, d] = swap(7, 13);
  disp(c);
  disp(d);
end

function test_multi_output_partial_consume()
  % `[a] = sumdiff(x, y)` for a 2-output callee: trailing output
  % becomes an ignored slot (discard temp).
  [s] = sumdiff(5, 3);
  disp(s);
end

function test_multi_output_ignore()
  % `~` lvalues become discard temps. Mix named + ignored.
  [~, d] = sumdiff(5, 3);
  disp(d);
  [s, ~] = sumdiff(8, 2);
  disp(s);
end

function test_multi_output_drop_all()
  % Bare statement form for an N-output user function: every output
  % dropped. The call's side-effect-free, but the cross-runner still
  % validates that the translator accepts the syntax and produces
  % matching stdout (i.e. nothing).
  swap(1, 2);
  disp(42);
end

function [a, b] = swap(x, y)
  a = y;
  b = x;
end

function [s, d] = sumdiff(x, y)
  s = x + y;
  d = x - y;
end

% -------- recursion + nargin/nargout pseudo-vars + void in ExprStmt --------

function test_recursive_call()
  % Direct self-recursion. The interpreter must let a function reach
  % its own dispatch slot the second time; the c-aot path must allow
  % a specialization to call itself by name.
  disp(fact(5));
end

function y = fact(n)
  if n <= 1
    y = 1;
  else
    y = n * fact(n - 1);
  end
end

function test_recursive_call_runtime_arg()
  % Self-recursion with a runtime (non-exact) argument: the recursive
  % call hits the SAME specialization key as the outer call, so the
  % lowerer can't side-step the recursion via per-value spec sharding
  % the way `fact(5)` does. Forces the placeholder-outputTypes seeding
  % + recursive-self-call re-lowering machinery in `specialize.ts`.
  n = 5;
  %!numbl:opaque n
  disp(fact(n));
end

function test_recursive_call_in_loop()
  % Loop-driven recursion: the loop index strips exact off `i`, so
  % each call to `fib(i)` hits the same opaque-arg specialization
  % and the recursive `fib(i-1) + fib(i-2)` inside likewise stays on
  % the same key. This is the canonical mtoc2 ↔ numbl `recursion.m`
  % shape.
  for i = 1:5
    disp(fib(i));
  end
end

function r = fib(n)
  if n <= 1
    r = n;
  else
    r = fib(n - 1) + fib(n - 2);
  end
end

function test_void_function_in_expr_stmt()
  % A user function that declares zero outputs, called as a bare
  % statement. Must not raise "too many output arguments" — that
  % was the regression when the interpreter shifted to numbl-style
  % nargout=0 ExprStmt handling.
  shout(99);
end

function shout(n)
  disp(n);
end

% -------- fewer-args calls (nargin-gated body) --------

function test_fewer_args_nargin_then()
  % `helper(a)` — only the `nargin < 2` arm runs. `b` is unbound in
  % this spec; the body must never reach a read of `b`.
  disp(fewerargs_h(2));
end

function test_fewer_args_nargin_else()
  % Same function, both args supplied — the `else` arm runs.
  disp(fewerargs_h(2, 99));
end

function y = fewerargs_h(a, b)
  if nargin < 2
    y = a + 10;
  else
    y = b;
  end
end

function test_fewer_args_zero()
  % Zero-arg call to a function that declares one param.
  disp(fewerargs_zero());
end

function v = fewerargs_zero(x)
  if nargin < 1
    v = 42;
  else
    v = x;
  end
end

function test_fewer_args_many()
  % Four declared, varying nargin. Each spec drops the unbound
  % param branches via the if-cond fold.
  disp(fewerargs_many(5));
  disp(fewerargs_many(5, 6));
  disp(fewerargs_many(5, 6, 7));
  disp(fewerargs_many(5, 6, 7, 8));
end

function s = fewerargs_many(a, b, c, d)
  s = 0;
  if nargin >= 1, s = s + a; end
  if nargin >= 2, s = s + b; end
  if nargin >= 3, s = s + c; end
  if nargin >= 4, s = s + d; end
end
