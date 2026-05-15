function sysmat = chunkermat(chnkr, fkern)
%CHUNKERMAT  Simplified dense system matrix for a boundary integral op.
%
% sysmat = CHUNKERMAT(chnkr, fkern) builds the N x N matrix
%   sysmat(i, j) = wts(j) * fkern(src(:, j), src_n(:, j), targ(:, i))
% where src/targ are the same N = k * nch boundary nodes carried by
% chnkr, and wts are the smooth Gauss-Legendre arclength weights.
%
% Self-interactions (i == j) are filled with 0 — the kernel is
% singular there and a proper log-singular quadrature correction is
% beyond this simplified version. For the chunkie ex00 CFIE flow the
% caller adds 0.5 * eye(N) on top of sysmat (the jump term), which
% covers the limit of the double-layer along the curve; the missing
% diagonal of the single-layer contributes O(1) error per row that
% can dominate at high frequency. Accuracy is limited; use a real
% chunkie quadrature for production.

N = chnkr.k * chnkr.nch;
src   = reshape(chnkr.r, 2, N);
src_n = reshape(chnkr.n, 2, N);
wts   = reshape(chnkr.wts, 1, N);

K = fkern(src, src_n, src);

% Zero the singular diagonal.
for i = 1:N
    K(i, i) = 0;
end

% Multiply each column by the corresponding arclength weight (smooth
% Gauss-Legendre quadrature applied to the source integral).
sysmat = K .* wts;

end
