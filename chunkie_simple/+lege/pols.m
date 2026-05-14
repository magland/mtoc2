function [pols, ders] = pols(xs, n)
%LEGE.POLS evaluate Legendre polynomials P_0..P_n at points xs via recursion.
%
% [pols, ders] = lege.pols(xs, n)
%   pols : (n+1) x size(xs) values, pols(i,j) = P_{i-1}(xs(j))
%   ders : (n+1) x size(xs) derivative values
%
% Adapted from chunkie/+lege/pols.m
% Copyright (C) 2009: Vladimir Rokhlin (FreeBSD license)

assert(n >= 0, 'n must be non-negative');
szx = size(xs);
xs = xs(:);

pols = zeros(length(xs), n+1);
ders = zeros(length(xs), n+1);

pols(:, 1) = ones(length(xs), 1);
ders(:, 1) = zeros(length(xs), 1);

if n <= 0
    pols = reshape(pols.', [n+1, szx]);
    ders = reshape(ders.', [n+1, szx]);
    return
end

pols(:, 2) = xs(:);
ders(:, 2) = ones(length(xs), 1);

if n == 1
    pols = reshape(pols.', [n+1, szx]);
    ders = reshape(ders.', [n+1, szx]);
    return
end

pk = ones(length(xs), 1);
xs2m1 = xs .^ 2 - 1.0;
pkp1 = pols(:, 2);

for k = 1:(n-1)
    pkm1 = pk;
    pk   = pkp1;
    pkp1 = ((2*k+1) * xs .* pk - k * pkm1) / (k+1);
    pols(:, k+2) = pkp1;
    ders(:, k+2) = (k+1) * (xs .* pkp1 - pk) ./ xs2m1;
end

pols = reshape(pols.', [n+1, szx]);
ders = reshape(ders.', [n+1, szx]);

end
