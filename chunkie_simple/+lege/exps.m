function [x, w, u, v] = exps(k)
%LEGE.EXPS Legendre nodes, weights, and value<->coefficient matrices.
%
% [x,w,u,v] = lege.exps(k)
%   x : k Legendre nodes on [-1,1]
%   w : corresponding integration weights
%   u : values -> coefficients (k x k)
%   v : coefficients -> values (k x k)

[x, w] = lege.rts_stab(k);

v = (lege.pols(x(:), k-1)).';
d = (2.0 * (1:k) - 1) / 2.0;
u = ((v) .* (w(:) * d)).';

end
