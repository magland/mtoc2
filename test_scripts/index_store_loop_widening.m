% Inside a loop body, an indexed write (`x(k) = ...`, `x(:) = ...`)
% must mark the base variable as assigned so its `exact` is stripped
% from the env BEFORE the body is lowered. Otherwise the one-pass
% lowering reads x's pre-loop exact, and an `if sum(x) > 0`-style
% cond inside the body folds at compile time using iter-1 values.
%
% The key trigger is the if-cond folder: codegen normally emits
% runtime calls for `sum(x)`, but the if folder reads cond.ty.exact
% directly and drops the dead arm. Without the loop-body widening,
% every iteration sees the same statically-folded branch.

test_index_write_in_for_strips_exact();
test_slice_write_in_for_strips_exact();
test_index_write_in_while_strips_exact();

function test_index_write_in_for_strips_exact()
  % The if-cond fold runs BEFORE the indexed write within the body,
  % so without loop-entry widening the cond reads x's pre-loop exact
  % (zeros) every iteration: sum is statically 0, the `> -1` fold
  % bakes in the wrong arm, and `disp(101)` is dropped.
  x = zeros(1, 4);
  for k = 1:4
    if sum(x) > 5
      disp(101);
    else
      disp(202);
    end
    x(k) = k;
  end
end

function test_slice_write_in_for_strips_exact()
  x = zeros(1, 4);
  for k = 1:2
    if sum(x) > 5
      disp(303);
    else
      disp(404);
    end
    x(2*k - 1 : 2*k) = [10 20];
  end
end

function test_index_write_in_while_strips_exact()
  x = zeros(1, 3);
  k = 1;
  while k <= 3
    if sum(x) > 5
      disp(505);
    else
      disp(606);
    end
    x(k) = 100;
    k = k + 1;
  end
end
