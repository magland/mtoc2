% After an indexed write `x(i) = v`, the runtime tensor `x` has been
% mutated, but the type-system entry for `x` still carries the
% pre-write `exact` Float64Array (set by `zeros(2,2)` etc.). Subsequent
% `sum.transfer` reads that stale `exact` and the if-cond folder
% drops the wrong arm at compile time. Each test below would silently
% mis-emit (wrong branch baked in) without a refresh.

test_scalar_write_invalidates_sum();
test_slice_write_invalidates_sum();
test_scalar_write_invalidates_disp();

function test_scalar_write_invalidates_sum()
  x = zeros(1, 4);
  x(1) = 5;
  if sum(x) > 0
    disp(11);
  else
    disp(22);
  end
end

function test_slice_write_invalidates_sum()
  x = zeros(1, 4);
  x(2:3) = [7 8];
  if sum(x) > 10
    disp(33);
  else
    disp(44);
  end
end

function test_scalar_write_invalidates_disp()
  % `disp(x)` reads the type's exact under the "scalar disp folds to
  % literal" path for scalars, but for tensors it always emits the
  % runtime helper — so this regression is mostly belt-and-suspenders.
  x = ones(1, 3);
  x(2) = 99;
  disp(x);
end
