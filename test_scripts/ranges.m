% Range edge cases: float-step rounding/snap, length-one collapses,
% step=0 empty.

test_count_when_quotient_underflows();
test_count_when_quotient_overshoots();
test_snap_last_element();
test_snap_inside_arithmetic();
test_step_zero_emits_empty();

test_basic_length_one_range();
test_length_one_with_step();
test_length_one_in_arithmetic();
test_length_one_disp_directly();

test_linspace_basic();
test_linspace_edges();
test_linspace_fractional();
test_linspace_default_n();
test_linspace_runtime_n();

% -------- float-step ranges --------

function test_count_when_quotient_underflows()
  % (0.3 - 0) / 0.1 = 2.9999999999999996; numbl rounds to 4 elements,
  % the naive `floor + 1` formula gives only 3.
  v = 0:0.1:0.3;
  disp(v);
  disp(numel(v));
end

function test_count_when_quotient_overshoots()
  v = 0:0.1:0.7;
  disp(v);
  disp(numel(v));
end

function test_snap_last_element()
  % Without snap, the last element drifts (0.30000000000000004). After
  % snap it equals 0.3 exactly, so a `== end` comparison succeeds.
  v = 0.1:0.1:0.3;
  if v(end) == 0.3
    disp(1);
  else
    disp(0);
  end
end

function test_snap_inside_arithmetic()
  v = (0:0.1:0.3) * 10;
  disp(v);
end

function test_step_zero_emits_empty()
  % step = 0 yields an empty range in numbl. mtoc2 must not abort or
  % loop forever; it should just produce a 1x0 vector.
  s = 0;
  e = 5;
  step = 0;
  v = s:step:e;
  disp(numel(v));
end

% -------- length-one ranges --------

function test_basic_length_one_range()
  % A statically-length-1 range like `1:1` (or `5:5:5`) is type-system
  % scalar. Lowering collapses MakeRange of length 1 to its start
  % expression so the LHS sees a scalar.
  x = 1:1;
  disp(x);
end

function test_length_one_with_step()
  x = 5:5:5;
  disp(x);
end

function test_length_one_in_arithmetic()
  x = (3:3) * 4;
  disp(x);
end

function test_length_one_disp_directly()
  disp(7:7);
end

% -------- linspace --------

function test_linspace_basic()
  disp(linspace(0, 1, 5));
  disp(linspace(-1, 1, 3));
  disp(linspace(1, 0, 5));   % negative-direction
  disp(linspace(0, 1, 2));   % just the two endpoints
end

function test_linspace_edges()
  % n == 1 → scalar `b` (mtoc2 collapses 1×1 to scalar, matching
  % numbl's "disp formats 1×1 as scalar" behavior byte-for-byte).
  disp(linspace(0, 1, 1));
  disp(linspace(-7, 42, 1));
  % n == 0 / n < 0 → empty tensor (disp prints nothing).
  disp(numel(linspace(0, 1, 0)));
  disp(numel(linspace(0, 1, -3)));
end

function test_linspace_fractional()
  disp(linspace(0.25, 1.25, 5));
  disp(linspace(-0.5, 0.5, 3));
end

function test_linspace_default_n()
  % 2-arg form defaults n = 100; checking length keeps the test output
  % stable (the full 100-element render diverges in formatting between
  % numbl and mtoc2's disp paths).
  disp(length(linspace(0, 1)));
  disp(length(linspace(2, 5)));
end

function test_linspace_runtime_n()
  n = 4;
  %!numbl:opaque n
  disp(linspace(0, 1, n));
  a = -2;
  b = 2;
  %!numbl:opaque a b
  disp(linspace(a, b, 5));
end
