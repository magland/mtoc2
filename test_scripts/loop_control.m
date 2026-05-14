% Control flow: for-loop bounds evaluation, descending positive bounds,
% variables first assigned inside If/While/For bodies, and if-cond
% folding preserving side effects.

test_end_var_mutation_doesnt_extend_loop();
test_start_var_mutation_doesnt_skip_iters();
test_count_eval_uses_iter_one_view();
test_for_descending_positive();
test_var_assigned_in_for();
test_loop_var_after_for();
test_var_assigned_in_if();
test_var_assigned_in_while();
test_var_assigned_in_elseif_chain();
test_call_in_cond_runs_when_then_taken();
test_call_in_cond_runs_when_else_taken();
test_call_in_elseif_chain();
test_arithmetic_in_cond_doesnt_double_count();

% -------- for-bounds evaluated once at loop entry --------

function test_end_var_mutation_doesnt_extend_loop()
  n = 3;
  iters = 0;
  last = 0;
  for k = 1:n
    n = 100;
    iters = iters + 1;
    last = k;
  end
  disp(iters);
  disp(last);
end

function test_start_var_mutation_doesnt_skip_iters()
  s = 1;
  iters = 0;
  last = 0;
  for k = s:5
    s = 4;
    iters = iters + 1;
    last = k;
  end
  disp(iters);
  disp(last);
end

function test_count_eval_uses_iter_one_view()
  e = 0;
  iters = 0;
  for k = 1:e
    e = 10;
    iters = iters + 1;
  end
  disp(iters);
end

% -------- descending positive bounds --------

function test_for_descending_positive()
  % A descending for-loop with positive bounds must NOT assign the
  % loop variable a `negative` sign — sign cascade is unify(start, end).
  for k = 5:-1:1
    disp(sqrt(k));
  end

  for k = -1:-1:-5
    disp(k);
  end
end

% -------- variables assigned in nested blocks stay in scope --------

function test_var_assigned_in_for()
  for k = 1:5
    a = k;
  end
  disp(a);
end

function test_loop_var_after_for()
  for k = 1:3
  end
  disp(k);
end

function test_var_assigned_in_if()
  x = 1;
  %!numbl:opaque x
  if x
    b = 7;
  end
  disp(b);
end

function test_var_assigned_in_while()
  i = 0;
  while i < 3
    i = i + 1;
    last = i * 10;
  end
  disp(last);
end

function test_var_assigned_in_elseif_chain()
  x = 2;
  %!numbl:opaque x
  if x == 1
    r = 100;
  elseif x == 2
    r = 200;
  else
    r = 300;
  end
  disp(r);
end

% -------- if-cond fold preserves side effects --------

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
  if 2 + 3 > 0
    disp(2000);
  else
    disp(3000);
  end
end
