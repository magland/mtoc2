% When the if-cond folds to a compile-time constant, the cond IR
% used to be discarded entirely — silently dropping any
% side-effecting subexpression. e.g. a user function whose
% specialization returns an exact literal but whose body has a
% `disp` would never actually run the disp. mtoc2 must preserve
% the cond's side effects (the COMPUTATION runs at runtime; only
% the BRANCH decision is folded out).

test_call_in_cond_runs_when_then_taken();
test_call_in_cond_runs_when_else_taken();
test_call_in_elseif_chain();
test_arithmetic_in_cond_doesnt_double_count();

function y = log_then_5()
  disp(123);
  y = 5;
end

function y = log_then_0()
  disp(456);
  y = 0;
end

function test_call_in_cond_runs_when_then_taken()
  % cond folds to true (5 > 0); the disp(123) inside log_then_5
  % must still run.
  if log_then_5() > 0
    disp(700);
  else
    disp(800);
  end
end

function test_call_in_cond_runs_when_else_taken()
  % cond folds to false (0 > 0); the disp(456) inside log_then_0
  % must still run.
  if log_then_0() > 0
    disp(700);
  else
    disp(800);
  end
end

function test_call_in_elseif_chain()
  if log_then_0() > 0
    disp(900);
  elseif log_then_5() > 10
    disp(1000);
  else
    disp(1100);
  end
end

function test_arithmetic_in_cond_doesnt_double_count()
  % Pure arithmetic cond folds without re-emitting; checks the fold
  % path doesn't re-issue a side effect twice.
  if 2 + 3 > 0
    disp(2000);
  else
    disp(3000);
  end
end
