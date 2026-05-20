test_func_if_fold_on_arg();
test_multi_output_swap();
test_multi_output_partial_consume();
test_multi_output_ignore();
test_multi_output_drop_all();
test_recursive_call();
test_void_function_in_expr_stmt();

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
