% Bug: an owned tensor local whose only post-allocation use is inside
% an `if` that contains `return;` never gets a scope-exit free along
% the return path. The early-free was scheduled after the `if`, so it
% only ran on the fall-through path; the forward `nullAtScopeExit`
% optimization treated `return;` as a no-op and proved the var NULL
% at function end (true on fall-through, false on the return path),
% so the scope-exit free was suppressed. LSan fired.
%
% Cross-runner builds with -fsanitize=address; this script must not
% trigger LeakSanitizer for the fix to hold.

bad(1);
bad(0);
nested_return(1);
nested_return(0);
two_owned(1);
two_owned(0);
disp(1);

function bad(do_return)
  %!numbl:opaque do_return
  x = [10, 20, 30];
  if do_return
    return;
  end
  disp(x);
end

function two_owned(do_return)
  %!numbl:opaque do_return
  a = [1 2 3];
  b = [4 5 6] * 2;
  if do_return
    return;
  end
  disp(a);
  disp(b);
end

function nested_return(cond)
  %!numbl:opaque cond
  outer = [1 2 3];
  if cond
    inner = [4 5 6];
    if cond
      return;
    end
    disp(inner);
  end
  disp(outer);
end
