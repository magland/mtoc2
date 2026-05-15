function u = chunkerkerneval(chnkr, fkern, density, targets)
%CHUNKERKERNEVAL  Evaluate a layer potential at off-boundary targets.
%
% u(i) = sum_j wts(j) * fkern(src(:, j), src_n(:, j), targets(:, i)) * density(j)
%
% Smooth Gauss-Legendre quadrature over the boundary. Targets must be
% strictly OFF the boundary (the kernel is singular there); for the
% chunkie ex00 flow the caller has already masked targets through
% chunkerinterior to exclude the closed interior.
%
% Inputs:
%   chnkr   - chunker object describing the boundary
%   fkern   - function handle (src, src_n, targ) -> Nt x Ns complex matrix
%   density - N x 1 complex column, the solved boundary density
%   targets - 2 x Nt target positions
%
% Output:
%   u - Nt x 1 complex column, the layer potential at each target.

N = chnkr.k * chnkr.nch;
src   = reshape(chnkr.r, 2, N);
src_n = reshape(chnkr.n, 2, N);
wts   = reshape(chnkr.wts, 1, N);

K = fkern(src, src_n, targets);   % Nt x N

% Apply quadrature weights along the source axis, then matrix-multiply
% by the density to combine into the per-target potential.
Kw = K .* wts;                    % Nt x N (broadcast over columns)
u = Kw * density;                 % Nt x 1

end
