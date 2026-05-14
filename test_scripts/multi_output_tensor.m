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
