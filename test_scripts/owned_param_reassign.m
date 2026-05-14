% Regression: an owned tensor / struct / handle parameter that the
% callee reassigns must not trigger a duplicate C declaration. Before
% the fix, the function-top pre-decl loop for owned locals would emit
% `mtoc2_tensor_t v = mtoc2_tensor_empty();` even though the function
% signature already declared `mtoc2_tensor_t v` — the C compiler then
% rejected the redeclaration.

test_tensor_param_reassign_colon();
test_tensor_param_reassign_arith();
test_tensor_param_reassign_then_index_read();
test_tensor_param_reassign_inside_loop();
test_struct_param_field_replace();

function test_tensor_param_reassign_colon()
  helper_reassign_colon([1; 2; 3; 4]);
end

function helper_reassign_colon(xs)
  xs = xs(:);
  disp(xs);
end

function test_tensor_param_reassign_arith()
  disp(helper_reassign_arith([10 20 30]));
end

function y = helper_reassign_arith(v)
  v = v + 1;
  v = v .* 2;
  y = v;
end

function test_tensor_param_reassign_then_index_read()
  disp(helper_index_after_reassign([5 6 7 8 9]));
end

function y = helper_index_after_reassign(v)
  v = v(:);
  y = v(3);
end

function test_tensor_param_reassign_inside_loop()
  disp(helper_loop_reassign([1 2 3]));
end

function y = helper_loop_reassign(v)
  for k = 1:3
    v = v + 1;
  end
  y = v;
end

function test_struct_param_field_replace()
  helper_struct_field_replace(struct('data', [1 2 3]));
end

function helper_struct_field_replace(s)
  s.data = s.data .* 10;
  disp(s.data);
end
