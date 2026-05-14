% Bug 10: a descending for-loop with positive bounds was assigning
% the loop variable a `negative` sign — the sign cascade only
% considered the step direction, ignoring the actual bounds. With
% `k :: double:negative`, calls into sign-domain-checking builtins
% (`sqrt(k)`, `log(k)`) rejected the loop variable.
%
% Fix: unify(startSign, endSign) — captures the value range of the
% arithmetic series regardless of step direction.

for k = 5:-1:1
  disp(sqrt(k));
end

for k = -1:-1:-5
  disp(k);
end
