function K = helm2d_combined(zk, coefs, src, src_n, targ)
%HELM2D_COMBINED  Helmholtz combined-field kernel matrix.
%
% K = HELM2D_COMBINED(zk, coefs, src, src_n, targ) builds the Nt x Ns
% kernel matrix K(i, j) = coefs(1) * D(targ_i, src_j) + coefs(2) * S(targ_i, src_j),
% where D and S are the double- and single-layer Helmholtz potentials
% with wavenumber zk and source-side normals src_n(:, j).
%
% Inputs:
%   zk     - real scalar, wavenumber
%   coefs  - 1x2 complex row [c_D, c_S]
%   src    - 2 x Ns source positions
%   src_n  - 2 x Ns source unit normals (only used for the D part)
%   targ   - 2 x Nt target positions
%
% Output:
%   K - Nt x Ns complex matrix.

Nt = size(targ, 2);
Ns = size(src, 2);

% Pairwise difference matrices: rx(i, j) = targ(1, i) - src(1, j).
% Reshape brings target rows to Nt×1 columns (so implicit expansion
% against the 1×Ns source rows builds the full Nt×Ns matrix). `.'` on
% an unknown-shape slice isn't yet supported in mtoc2, so we use
% reshape with the runtime Nt instead.
tx = reshape(targ(1, :), Nt, 1);
ty = reshape(targ(2, :), Nt, 1);
sx = reshape(src(1, :), 1, Ns);
sy = reshape(src(2, :), 1, Ns);
rx = tx - sx;
ry = ty - sy;
r  = sqrt(rx .^ 2 + ry .^ 2);

zkr = zk * r;
h0 = besselh(0, 1, zkr);
h1 = besselh(1, 1, zkr);

% Single layer: S(x, y) = (1i/4) * H_0^(1)(zk * r)
S_part = (1i / 4) * h0;

% Double layer: D(x, y) = +(1i/4) * H_1^(1)(zk * r) * zk * (n_y . (x - y)) / r
nx = reshape(src_n(1, :), 1, Ns);
ny = reshape(src_n(2, :), 1, Ns);
D_part = (1i / 4) * h1 * zk .* (rx .* nx + ry .* ny) ./ r;

K = coefs(1) * D_part + coefs(2) * S_part;

end
