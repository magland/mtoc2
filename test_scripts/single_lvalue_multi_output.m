% A multi-output declared function called with a single lvalue (or in
% expression position) specializes the callee with nargout=1: its
% output list truncates to one entry and it emits as a return-by-value
% C function. Mirrors numbl's nargout semantics. The unwanted output
% branches are kept in the body but dead-coded by the nargout fold
% where the callee tests `if nargout >= N`.

test_single_lvalue_explicit();
test_expression_position();
test_drop_all_via_bare_call();
test_bracketed_one_lvalue();
test_nested_in_arith();
test_nested_in_disp();
test_tensor_return_in_expr();

function test_single_lvalue_explicit()
  % `[a] = ...` with one bracketed lvalue.
  [a] = two_out(7);
  disp(a);
end

function test_expression_position()
  % `x = f(...)` for a 2-output f.
  x = two_out(11);
  disp(x);
end

function test_drop_all_via_bare_call()
  three_out_print();
end

function test_bracketed_one_lvalue()
  % First output only; the function's body skips the others via
  % `if nargout >= N`.
  a = first_only(5);
  disp(a);
end

function test_nested_in_arith()
  % The single-lvalue call appears as a subexpression — needs ANF
  % hoisting plus the truncated-spec path.
  disp(two_out(3) + 100);
end

function test_nested_in_disp()
  disp(two_out(2));
end

function test_tensor_return_in_expr()
  % Tensor first output, scalar second. Single-lvalue call picks the
  % tensor and emits the single-output owned-return ABI.
  t = mixed_t(4);
  disp(t);
end

function [a, b] = two_out(n)
  a = n * 2;
  b = n * 3;
end

function three_out_print()
  disp(100);
end

function [a, b, c] = first_only(n)
  a = n + 1;
  if nargout >= 2
    b = n + 2;
  end
  if nargout >= 3
    c = n + 3;
  end
end

function [t, s] = mixed_t(n)
  t = ones(1, n) * 10;
  s = n;
end
