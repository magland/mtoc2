function x = gmres(A, b, tol, maxit)
%GMRES   Simplified full GMRES for the chunkie CFIE solve.
%
%   x = gmres(A, b, tol, maxit) returns x with A*x ~ b. Fixed-arity:
%   no restart, no preconditioner, initial guess always zero. Stops
%   when the rotated residual norm drops below tol*||b||, or after
%   maxit Arnoldi steps.
%
%   The chunkie ex00 driver calls MATLAB's stock gmres as
%       sol = gmres(sysmat, rhs, [], 1e-13, 100);
%   where `[]` means "no restart". This routine drops that arg and
%   takes (A, b, tol, maxit) directly.
%
%   Implementation choices that matter for mtoc2:
%
%     * V/H/cs/sn/g are pre-allocated as zero tensors that inherit
%       b's element type (real or complex) via `b(1)*0`. A complex
%       rhs gives complex Krylov storage; a real rhs gives real
%       storage. No branching on type at the source level — the
%       lattice does the work.
%
%     * Inner products use `sum(conj(V(:, i)) .* w)` instead of
%       `V(:, i)' * w`. Mathematically identical; avoids routing
%       the inner product through the matrix-multiply path.
%
%     * The final solution update accumulates one column at a time
%       (`x = x + V(:, j) * y(j)`) instead of `x + V(:, 1:k)*y`.
%       Same answer; the scalar-times-column path stays in the
%       elementwise lane for every operand type.
%
%     * The k-by-k upper-triangular solve uses an explicit back-
%       substitution loop. mtoc2 has no backslash.

n = length(b);

% Scalar zero that matches b's type. Multiplying real zeros() by
% this scalar promotes the tensor to complex iff b is complex.
zb = b(1) * 0;

% Initial guess and residual. With x0 = 0, r0 = b.
x = b * 0;
r = b;
beta = norm(r);

if beta == 0
    return
end

% Arnoldi storage. V holds the orthonormal Krylov basis as columns;
% H is the (maxit+1) x maxit upper-Hessenberg matrix produced by
% modified Gram-Schmidt orthogonalization.
V = zeros(n,         maxit + 1) + zb;
H = zeros(maxit + 1, maxit)     + zb;

V(:, 1) = r / beta;

% Givens rotation state and the rotated right-hand side. Same type
% promotion as V/H.
cs = zeros(maxit,     1) + zb;
sn = zeros(maxit,     1) + zb;
g  = zeros(maxit + 1, 1) + zb;
g(1) = beta;

niter = 0;
for k = 1:maxit
    % --- Arnoldi: orthogonalize A*V(:, k) against V(:, 1:k).
    w = A * V(:, k);
    for i = 1:k
        % Inner product V(:, i)' * w via elementwise conj + sum.
        hi = sum(conj(V(:, i)) .* w);
        H(i, k) = hi;
        w = w - hi * V(:, i);
    end
    H(k+1, k) = norm(w);
    if abs(H(k+1, k)) > 0
        V(:, k+1) = w / H(k+1, k);
    end

    % --- Apply stored Givens rotations to the new column H(:, k).
    for i = 1:k-1
        tmp        =  conj(cs(i)) * H(i,   k) + conj(sn(i)) * H(i+1, k);
        H(i+1, k)  = -sn(i)       * H(i,   k) + cs(i)       * H(i+1, k);
        H(i,   k)  = tmp;
    end

    % --- New rotation that zeros H(k+1, k). Saad-style convention:
    %       c = a / t,  s = b / t,  t = sqrt(|a|^2 + |b|^2)
    % so that conj(c)*a + conj(s)*b = t (real, positive) and
    %       -s*a + c*b = 0. The rotation matrix is
    %       [ conj(c)  conj(s) ;  -s   c ]
    % which is what the apply blocks above and below use.
    a  = H(k,   k);
    bb = H(k+1, k);
    aa_mag = abs(a);
    bb_mag = abs(bb);
    if bb_mag == 0
        if aa_mag == 0
            cs(k) = 1;
        else
            cs(k) = a / aa_mag;
        end
        sn(k) = 0;
    else
        denom = sqrt(aa_mag * aa_mag + bb_mag * bb_mag);
        cs(k) = a  / denom;
        sn(k) = bb / denom;
    end

    H(k,   k) = conj(cs(k)) * a + conj(sn(k)) * bb;
    H(k+1, k) = 0;

    % --- Rotate g.
    tmp    =  conj(cs(k)) * g(k) + conj(sn(k)) * g(k+1);
    g(k+1) = -sn(k)       * g(k) + cs(k)       * g(k+1);
    g(k)   = tmp;

    niter = k;
    if abs(g(k+1)) / beta < tol
        break
    end
end

% --- Back-substitute on the niter x niter upper-triangular block.
y = zeros(niter, 1) + zb;
for i = niter:-1:1
    s = g(i);
    for j = i+1:niter
        s = s - H(i, j) * y(j);
    end
    y(i) = s / H(i, i);
end

% --- Solution update x += V(:, 1:niter) * y, one column at a time.
for j = 1:niter
    x = x + V(:, j) * y(j);
end

end
