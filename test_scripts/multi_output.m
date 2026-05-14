% Multi-output user functions: tensor / struct / scalar outputs,
% single-lvalue and bare-call drop-all forms, nargout/nargin pseudo-vars,
% and the specialization-by-nargout fold.

test_two_tensor_outputs_simple();
test_three_tensor_outputs();
test_discard_first_output();
test_discard_middle_outputs();
test_partial_dropping_via_nargout();
test_reassign_outputs_in_body();
test_outputs_written_in_branch();
test_outputs_written_in_loop();
test_nested_multi_output();
test_mixed_scalar_and_tensor_outputs();

test_struct_outputs();
test_struct_with_tensor_field();

test_single_lvalue_explicit();
test_expression_position();
test_drop_all_via_bare_call();
test_bracketed_one_lvalue();
test_nested_in_arith();
test_nested_in_disp();
test_tensor_return_in_expr();

test_nargout_inside_function();
test_nargout_specialization_per_caller();
test_nargin_inside_function();
test_nargout_in_branch();
test_nargout_multi_assign();

% -------- multi_output_tensor --------

function test_two_tensor_outputs_simple()
  [a, b] = swap_double([1 2 3], [4 5 6]);
  disp(a);
  disp(b);
end

function test_three_tensor_outputs()
  [p, d, t] = compute_pdt(4);
  disp(p);
  disp(d);
  disp(t);
end

function test_discard_first_output()
  [~, d] = swap_double([1 2 3], [4 5 6]);
  disp(d);
end

function test_discard_middle_outputs()
  [a, ~, t] = compute_pdt(4);
  disp(a);
  disp(t);
end

function test_partial_dropping_via_nargout()
  [p, d] = compute_pdt(4);
  disp(p);
  disp(d);
end

function test_reassign_outputs_in_body()
  [a, b] = reassign_in_body(3);
  disp(a);
  disp(b);
end

function test_outputs_written_in_branch()
  [a, b] = branch_writes(5);
  disp(a);
  disp(b);
  [c, d] = branch_writes(-5);
  disp(c);
  disp(d);
end

function test_outputs_written_in_loop()
  [a, b] = loop_writes(3);
  disp(a);
  disp(b);
end

function test_nested_multi_output()
  [r, s] = nested_caller(4);
  disp(r);
  disp(s);
end

function test_mixed_scalar_and_tensor_outputs()
  [k, v] = mixed_outputs(7);
  disp(k);
  disp(v);
end

function [a, b] = swap_double(x, y)
  a = y;
  b = x;
end

function [pol, der, tot] = compute_pdt(n)
  pol = ones(1, n);
  der = zeros(1, n);
  for k = 1:n
    pol(k) = k;
    der(k) = k * 2;
  end
  if nargout >= 3
    tot = pol + der;
  else
    tot = zeros(1, n);
  end
end

function [a, b] = reassign_in_body(n)
  a = ones(1, n);
  a = a + 1;
  a = a .* 3;
  b = zeros(1, n);
  for k = 1:n
    b(k) = a(k) + 10;
  end
end

function [a, b] = branch_writes(x)
  if x > 0
    a = [1 2 3];
    b = [4 5 6];
  else
    a = [-1 -2 -3];
    b = [-4 -5 -6];
  end
end

function [a, b] = loop_writes(n)
  a = zeros(1, n);
  b = zeros(1, n);
  for k = 1:n
    a = a + k;
    b = b * 2 + 1;
  end
end

function [r, s] = nested_caller(n)
  [r, s] = swap_double(ones(1, n), ones(1, n) * 2);
end

function [k, v] = mixed_outputs(n)
  k = n + 1;
  v = ones(1, n);
end

% -------- multi_output_struct --------

function test_struct_outputs()
  [s1, s2] = make_two_structs(3, 4);
  disp(s1.x);
  disp(s2.y);
end

function test_struct_with_tensor_field()
  [bag, total] = make_bag([1 2 3 4 5]);
  disp(bag.data);
  disp(total);
end

function [a, b] = make_two_structs(x, y)
  a = struct('x', x);
  b = struct('y', y);
end

function [b, t] = make_bag(d)
  b = struct('data', d);
  t = sum(d);
end

% -------- single_lvalue_multi_output --------

function test_single_lvalue_explicit()
  [a] = two_out(7);
  disp(a);
end

function test_expression_position()
  x = two_out(11);
  disp(x);
end

function test_drop_all_via_bare_call()
  three_out_print();
end

function test_bracketed_one_lvalue()
  a = first_only(5);
  disp(a);
end

function test_nested_in_arith()
  disp(two_out(3) + 100);
end

function test_nested_in_disp()
  disp(two_out(2));
end

function test_tensor_return_in_expr()
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

% -------- nargout_nargin --------

function test_nargout_inside_function()
  disp(report_nargout(7));
end

function test_nargout_specialization_per_caller()
  % `pair` is specialized twice: once at the bare-call site (nargout=0,
  % drop-all), once at the multi-assign site (nargout=2). The
  % `if nargout >= 2` branch fires at the multi-assign site only.
  [u, v] = pair(7);
  disp(u);
  disp(v);

  pair(9);
  disp(100);
end

function test_nargin_inside_function()
  disp(report_nargin(5));
  disp(report_nargin_pair(5, 11));
end

function test_nargout_in_branch()
  disp(maybe_double(3));
  [a, b] = maybe_double_pair(3);
  disp(a);
  disp(b);
end

function test_nargout_multi_assign()
  [a, b] = triple_or_less(4);
  disp(a);
  disp(b);
  [a2, b2, c] = triple_or_less(4);
  disp(a2);
  disp(b2);
  disp(c);
end

function y = report_nargout(x)
  y = x + nargout;
end

function [a, b] = pair(x)
  a = x;
  if nargout >= 2
    b = x * 10;
  else
    b = 0;
  end
end

function y = report_nargin(x)
  y = nargin;
end

function y = report_nargin_pair(x, z)
  y = nargin + x + z;
end

function y = maybe_double(x)
  if nargout >= 1
    y = x * 2;
  else
    y = x;
  end
end

function [a, b] = maybe_double_pair(x)
  if nargout >= 2
    a = x * 2;
    b = x * 3;
  else
    a = x;
    b = 0;
  end
end

function [a, b, c] = triple_or_less(x)
  a = x + 1;
  if nargout >= 2
    b = x + 2;
  else
    b = 0;
  end
  if nargout >= 3
    c = x + 3;
  else
    c = 0;
  end
end
