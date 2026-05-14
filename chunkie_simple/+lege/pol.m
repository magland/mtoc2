function [pol, der] = pol(xs, n)
%LEGE.POL evaluate the nth Legendre polynomial (and derivative) at xs.
%
% Adapted from chunkie/+lege/pol.m
% Copyright (C) 2009: Vladimir Rokhlin (FreeBSD license)

if n <= 0
    pol = ones(size(xs));
    der = zeros(size(xs));
    return
end

if n == 1
    pol = xs;
    der = ones(size(xs));
    return
end

pk  = ones(size(xs));
pol = xs;

for k = 1:(n-1)
    pkm1 = pk;
    pk   = pol;
    pol  = ((2*k+1) * xs .* pk - k * pkm1) / (k+1);
end

der = n * (xs .* pol - pk) ./ (xs .^ 2 - 1);

end
