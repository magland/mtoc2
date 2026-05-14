% Bugs 7/8/15: the type lattice's `exact` field must only carry
% finite values. Without the discipline, scalar / tensor folds bake
% NaN and ±Infinity into the exact slot; the canonical spec key uses
% JSON.stringify, which collapses every non-finite to `null` →
% distinct exact tensors collide on the specialization key.

% Reductions over a tensor containing Inf
n = prod([1/0, 0]);   % Inf * 0 = NaN
disp(n);

m = sum([1/0, 1]);    % Inf + 1 = Inf
disp(m);

% A scalar fold that produces a non-finite value (-(Inf) = -Inf)
k = -(1/0);
disp(k);

% Two exact tensors whose values would collide under JSON.stringify
% (both [null, null]) once non-finite leaks into `exact`. Pass each
% through a user function so the specialization key is exercised.
a = [1/0, 0];
b = [0, 1/0];
disp(use_exact(a));
disp(use_exact(b));

function y = use_exact(t)
  y = sum(t);
end
