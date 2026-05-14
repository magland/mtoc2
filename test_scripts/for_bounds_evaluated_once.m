% MATLAB / numbl evaluate `1:n` (and `1:step:n`) ONCE at loop entry,
% turning the range into a vector and iterating over it. mtoc2 used to
% emit `for (double k = startC; k <= endC; k += step)` which re-reads
% `endC` (and `startC`) every iteration — so a body that mutates `n`
% turns the loop into a hundred-iter loop, and a side-effecting `f()`
% in the bound is called once per iteration.

test_end_var_mutation_doesnt_extend_loop();
test_start_var_mutation_doesnt_skip_iters();
test_count_eval_uses_iter_one_view();

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
  % An empty range at entry stays empty even if mutating `e` inside
  % the body would later make it non-empty (the loop never runs at
  % all in MATLAB).
  e = 0;
  iters = 0;
  for k = 1:e
    e = 10;
    iters = iters + 1;
  end
  disp(iters);
end
