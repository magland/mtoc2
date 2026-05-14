% Bug: an owned tensor parameter that the callee never reassigns
% (and never early-frees through liveness) gets no scope-exit free.
% The forward `nullAtScopeExit` dataflow incorrectly seeds the param
% as "null at entry" alongside the locals, so it stays in the null-set
% and the free is skipped — LSan would fire on every such call.
%
% The cross-runner runs every script under -fsanitize=address with
% LSAN_OPTIONS=exitcode=0 and FAILs on `LeakSanitizer:` in stderr.

unused_tensor_param([1 2 3]);
read_only_tensor_param([4 5 6]);
struct_param_unused(struct('m', [7 8 9]));
disp(1);

function unused_tensor_param(v)
  % Param is never read or assigned. Body is empty.
end

function read_only_tensor_param(v)
  % Param is read once for disp; not reassigned. The early-free
  % dataflow may already free here, but the regression case is when
  % no early-free fires (e.g. if disp doesn't count as a "last use"
  % because of how non-owning consume sites are handled).
  disp(v);
end

function struct_param_unused(s)
  % Owned struct param (carries an owned tensor field) — same bug
  % class as the tensor param. The struct's destructor must run.
end
