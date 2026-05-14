% mtoc2-test-mask: ^Elapsed time is [0-9.]+ seconds\.$

test_tic_toc_bare();
test_tic_toc_assigned();
test_toc_in_expr();
test_tic_returns_start();
test_tic_assigned_to_var();

function test_tic_toc_bare()
  tic;
  toc;
end

function test_tic_toc_assigned()
  tic;
  t = toc;
  % `t = toc` must NOT print. The mask above will normalize any
  % stray "Elapsed time is ..." line, but we additionally check the
  % returned value is non-negative — a clean `disp(1)` here confirms
  % both behaviors on numbl and mtoc2.
  if t >= 0
    disp(1);
  else
    disp(0);
  end
end

function test_toc_in_expr()
  tic;
  % Adding a small constant to toc consumes the value, so no print.
  z = toc + 0.0;
  if z >= 0
    disp(1);
  else
    disp(0);
  end
end

function test_tic_returns_start()
  s = tic;
  % `s = tic` returns the wall-clock start time. CLOCK_MONOTONIC is
  % monotonically non-decreasing and starts > 0 on every realistic
  % POSIX system, so `s > 0` should hold for any non-zero uptime.
  if s > 0
    disp(1);
  else
    disp(0);
  end
end

function test_tic_assigned_to_var()
  tic;
  t1 = toc;
  % After `tic` then `t1 = toc`, t1 must be non-negative. The two
  % calls are back-to-back, so t1 may legitimately be 0 on coarse
  % clocks; the `>=` is intentional.
  if t1 >= 0
    disp(1);
  else
    disp(0);
  end
end
