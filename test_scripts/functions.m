test_func_if_fold_on_arg();

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
