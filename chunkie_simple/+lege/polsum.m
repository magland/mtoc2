function [pol, der, tot] = polsum(xs, n)
%LEGE.POLSUM evaluate nth Legendre polynomial plus normalized squared sum
% used by lege.rts_stab to compute quadrature weights.
%
% Adapted from chunkie/+lege/polsum.m
% Copyright (C) 2009: Vladimir Rokhlin (FreeBSD license)

pol = ones(size(xs));
der = zeros(size(xs));
tot = pol .^ 2 / 2.0;

if n <= 0
    return
end

pol = xs;
der = ones(size(xs));
tot = tot + pol .^ 2 .* (1 + 0.5);

if n == 1
    return
end

pk  = ones(size(xs));
pol = xs;

for k = 1:(n-1)
    pkm1 = pk;
    pk   = pol;
    pol  = ((2*k+1) * xs .* pk - k * pkm1) / (k+1);
    tot  = tot + pol .^ 2 .* (k + 1 + 0.5);
end

der = n * (xs .* pol - pk) ./ (xs .^ 2 - 1);

end
