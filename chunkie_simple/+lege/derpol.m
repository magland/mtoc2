function dercoeffs = derpol(coeffs)
%LEGE.DERPOL coefficients of the derivative of a Legendre expansion.
%
% Adapted from chunkie/+lege/derpol.m

sz = size(coeffs);
sz(1) = max(sz(1) - 1, 0);
n = sz(1);
dercoeffs = zeros(sz);

if n <= 0
    return
end

pk   = coeffs(n+1, :);
pkm1 = coeffs(end-1, :);
% chunkie initializes pkm2 = 0 (a scalar) and lets MATLAB widen it to
% a row vector on the first iteration; mtoc2's C locals have a fixed
% storage shape, so initialize as the equivalent-shape zero row.
pkm2 = 0 * pkm1;

for k = (n+1):-1:2
    j = k - 1;
    dercoeffs(k-1, :) = pk * (2*j - 1);
    if k > 2
        pkm2 = coeffs(k-2, :) + pk;
    end
    pk   = pkm1;
    pkm1 = pkm2;
end

end
