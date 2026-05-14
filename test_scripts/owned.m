% Owned-value lifecycle regressions: early-return free along the return
% path, and parameter-reassignment not double-declaring the C local.
% The cross-runner builds with -fsanitize=address; LeakSanitizer must
% not fire.

bad(1);
bad(0);
nested_return(1);
nested_return(0);
two_owned(1);
two_owned(0);
disp(1);

% Owned-param-leak regressions: a tensor / struct parameter that the
% callee never reassigns (and never early-frees through liveness) must
% still get a scope-exit free. Forward `nullAtScopeExit` must NOT seed
% params as "null at entry" alongside locals.
unused_tensor_param([1 2 3]);
read_only_tensor_param([4 5 6]);
struct_param_unused(struct('m', [7 8 9]));
disp(2);

test_tensor_param_reassign_colon();
test_tensor_param_reassign_arith();
test_tensor_param_reassign_then_index_read();
test_tensor_param_reassign_inside_loop();
test_struct_param_field_replace();

% -------- early-return free along return path --------

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

% -------- owned-param leak: param never reassigned --------

function unused_tensor_param(v)
  % Param is never read or assigned. Body is empty.
end

function read_only_tensor_param(v)
  % Param read once for disp; not reassigned. The early-free dataflow
  % may already free here, but the regression case is when no early-
  % free fires (e.g. if disp doesn't count as a "last use" because of
  % how non-owning consume sites are handled).
  disp(v);
end

function struct_param_unused(s)
  % Owned struct param (carries an owned tensor field) — same bug
  % class as the tensor param. The struct's destructor must run.
end

% -------- owned-param reassign without redeclaration --------

function test_tensor_param_reassign_colon()
  helper_reassign_colon([1; 2; 3; 4]);
end

function helper_reassign_colon(xs)
  xs = xs(:);
  disp(xs);
end

function test_tensor_param_reassign_arith()
  disp(helper_reassign_arith([10 20 30]));
end

function y = helper_reassign_arith(v)
  v = v + 1;
  v = v .* 2;
  y = v;
end

function test_tensor_param_reassign_then_index_read()
  disp(helper_index_after_reassign([5 6 7 8 9]));
end

function y = helper_index_after_reassign(v)
  v = v(:);
  y = v(3);
end

function test_tensor_param_reassign_inside_loop()
  disp(helper_loop_reassign([1 2 3]));
end

function y = helper_loop_reassign(v)
  for k = 1:3
    v = v + 1;
  end
  y = v;
end

function test_struct_param_field_replace()
  helper_struct_field_replace(struct('data', [1 2 3]));
end

function helper_struct_field_replace(s)
  s.data = s.data .* 10;
  disp(s.data);
end
