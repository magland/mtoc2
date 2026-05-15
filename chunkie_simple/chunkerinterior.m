function in = chunkerinterior(chnkr, targets)
%CHUNKERINTERIOR  Test whether 2-D points lie inside the discretized curve.
%
% in = CHUNKERINTERIOR(chnkr, targets) returns a 1 x M row vector with
% in(j) == 1 when targets(:, j) lies inside the closed curve described
% by chnkr, and 0 otherwise.
%
% Inputs:
%   chnkr   - chunker object (with fields r, d, k, nch)
%   targets - 2 x M positions to test
%
% Output:
%   in - 1 x M vector of 0/1 doubles (logical-equivalent; mtoc2's `~`
%        operator accepts this as a logical value).
%
% Algorithm:
%   Evaluate the Cauchy winding number
%
%       w(t) = (1/(2*pi*i)) * oint dz / (z - t)
%
%   over the closed boundary by Gauss-Legendre quadrature on each
%   chunk. Treating each boundary node as a complex number
%   z = rx + 1i*ry, and using the parameter-domain tangent
%   dz/du = dx + 1i*dy (chnkr.d), the quadrature is
%
%       w(t) ~ (1/(2*pi*i)) * sum_n  (dz_n * w_k_n) / (z_n - t)
%
%   where w_k_n are the Legendre parameter weights laid out per node.
%   For points inside the curve w(t) ~ 1; outside it is ~ 0. We
%   threshold |Re(w) - 1| < 0.5 and emit the result as a 0/1 double.
%
%   To keep memory bounded for large target grids the contribution
%   matrix is not fully materialized; we loop over targets one at a
%   time. The inner contraction over N = k * nch boundary nodes is
%   still vectorized.

k = chnkr.k;
nch = chnkr.nch;
N = k * nch;
M = size(targets, 2);

% Flatten boundary nodes / tangents to 1 x N rows.
rx = reshape(chnkr.r(1, :, :), 1, N);
ry = reshape(chnkr.r(2, :, :), 1, N);
dx = reshape(chnkr.d(1, :, :), 1, N);
dy = reshape(chnkr.d(2, :, :), 1, N);

zs = rx + 1i * ry;          % 1 x N  (boundary positions as complex)
dz = dx + 1i * dy;          % 1 x N  (parameter-domain tangents)

% Legendre weights on one chunk, broadcast (column-major) into a 1 x N
% row that repeats ws once per chunk. The outer product ws(:) * ones(1, nch)
% builds a k x nch matrix; reshape flattens column-by-column so each
% chunk's k weights stay contiguous.
[~, ws] = lege.exps(k);
ws_grid = ws(:) * ones(1, nch);             % k x nch
ws_full = reshape(ws_grid, 1, N);           % 1 x N

% Pre-multiply the tangent by the parameter weights once.
dz_w = dz .* ws_full;                       % 1 x N (complex)

inv_2pi = 1.0 / (2.0 * pi);

in = zeros(1, M);
for j = 1:M
    t = targets(1, j) + 1i * targets(2, j);
    diff_v = zs - t;                        % 1 x N (complex)
    contrib = dz_w ./ diff_v;               % 1 x N (complex)
    w_complex = sum(contrib);               % complex scalar
    % w = w_complex / (2*pi*i)
    % Multiplying by -i/(2*pi) gives Re(w) = imag(w_complex) / (2*pi).
    w_real = imag(w_complex) * inv_2pi;
    if abs(w_real - 1.0) < 0.5
        in(j) = 1;
    end
end

end
