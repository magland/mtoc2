function x = gmres(A, b, tol, maxit)
%GMRES  Simplified Generalized Minimal Residual solver.
%
% x = GMRES(A, b, tol, maxit) approximates the solution of A*x = b for
% a (real or complex) square matrix A. Iterates up to `maxit` Arnoldi
% steps until the relative residual falls below `tol`. No restart, no
% preconditioner — sized for moderate-N CFIE matrices.
%
% Signature is FIXED-ARITY (no varargin). The original MATLAB form
% `gmres(A, b, restart, tol, maxit)` collapses here to four positional
% args, dropping the restart slot (we always run full GMRES).

n = length(b);

% Start from x0 = 0; r0 = b. Use b * 0 to seed an owned column with
% the right (possibly complex) element type.
x = b * 0;
r = b;
beta = norm(r);

if beta == 0
    return
end

% Pre-allocate Arnoldi basis V (n x (maxit+1)) and Hessenberg H
% (maxit+1 x maxit). Seed with b * 0 so the complex element type is
% propagated through the indexed writes below.
V = b * 0 * zeros(1, maxit + 1);   % n x (maxit+1) (complex if b is)
H = b(1) * 0 * zeros(maxit + 1, maxit);  % (maxit+1) x maxit complex

V(:, 1) = r / beta;

% Givens rotation history (one cs/sn pair per Arnoldi step) and the
% running residual vector g (size maxit+1). g(1) starts at beta and
% gets transformed by each rotation.
cs = zeros(maxit, 1);
sn = b(1) * 0 * zeros(maxit, 1);   % may be complex
g  = b(1) * 0 * zeros(maxit + 1, 1);
g(1) = beta;

iters = 0;
for k = 1:maxit
    % Arnoldi step: w = A * V(:, k), orthogonalize against V(:, 1:k).
    % Inner product via `sum(conj(V(:,j)) .* w)` rather than
    % `V(:,j)' * w` — `'` on a column of statically-unknown length
    % isn't yet supported in mtoc2.
    w = A * V(:, k);
    for j = 1:k
        H(j, k) = sum(conj(V(:, j)) .* w, 'all');
        w = w - H(j, k) * V(:, j);
    end
    H(k + 1, k) = norm(w);
    if H(k + 1, k) ~= 0
        V(:, k + 1) = w / H(k + 1, k);
    end

    % Apply previously-stored Givens rotations to column k of H.
    for j = 1:(k - 1)
        h_j   = H(j, k);
        h_jp1 = H(j + 1, k);
        H(j,     k) =  conj(cs(j)) * h_j + conj(sn(j)) * h_jp1;
        H(j + 1, k) = -sn(j)        * h_j + cs(j)      * h_jp1;
    end

    % Compute and apply the new Givens rotation that zeros H(k+1, k).
    a = H(k, k);
    b_h = H(k + 1, k);
    denom = sqrt(abs(a)^2 + abs(b_h)^2);
    if denom == 0
        cs(k) = 1;
        sn(k) = 0;
    else
        cs(k) = abs(a) / denom;
        if a == 0
            sn(k) = b_h / denom;
        else
            sn(k) = (b_h * conj(a)) / (abs(a) * denom);
        end
    end
    H(k,     k) =  conj(cs(k)) * a + conj(sn(k)) * b_h;
    H(k + 1, k) = 0;

    % Update residual estimate g.
    g_k = g(k);
    g(k)     =  conj(cs(k)) * g_k;
    g(k + 1) = -sn(k)        * g_k;

    iters = k;
    if abs(g(k + 1)) <= tol * beta
        break
    end
end

% Back-substitute to recover y from H(1:iters, 1:iters) * y = g(1:iters).
y = b(1) * 0 * zeros(iters, 1);
for i = iters:-1:1
    s = g(i);
    for j = (i + 1):iters
        s = s - H(i, j) * y(j);
    end
    y(i) = s / H(i, i);
end

% Form x = V(:, 1:iters) * y. Loop additively to keep the slice
% pattern within mtoc2's supported range-write set.
for i = 1:iters
    x = x + V(:, i) * y(i);
end

end
