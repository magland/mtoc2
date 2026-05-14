% Float-step ranges where (end - start) / step is an integer in math
% but evaluates to (integer - epsilon) in IEEE 754. numbl bumps the
% count by 1e-10 before flooring and snaps the last element to `end`.
% mtoc2 must match byte-for-byte.

test_count_when_quotient_underflows();
test_count_when_quotient_overshoots();
test_snap_last_element();
test_snap_inside_arithmetic();
test_step_zero_emits_empty();

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
