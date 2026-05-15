% Starfish CFIE solve — Helmholtz scattering from a sound-soft starfish.
%
% Adapted from the chunkie example:
%   - chunkerfunc takes maxchunklen as a scalar (no struct opts arg);
%     pass 0 for "no constraint" or e.g. 4/zk to bound chunks by
%     wavelength.
%   - gmres is the simplified 4-arg form (A, b, tol, maxit) — no
%     restart slot.
%   - chnkr.r(:,:) flattens via explicit reshape (mtoc2 needs all
%     axes covered when slicing a >2-D tensor).
%   - `.'` on unknown-shape rows is unsupported, so the planewave
%     handle uses reshape to make its column-vector result.

% planewave definitions

tic;

kvec = 20*[1; -1.5];
zk = norm(kvec);
planewave = @(kvec, r) reshape( ...
    exp(1i * sum(bsxfun(@times, kvec(:), r), 1)), ...
    size(r, 2), 1);

% discretize domain

narms = 5;
amp = 0.5;
chnkr = chunkerfunc(@(t) starfish(t, narms, amp), 4 / zk);

N = chnkr.k * chnkr.nch;

% build CFIE and solve

fkern = kernel('helm', 'c', zk, [1, -zk*1i]);
sysmat = chunkermat(chnkr, fkern);
sysmat = 0.5 * eye(N) + sysmat;

boundary = reshape(chnkr.r, 2, N);
rhs = -planewave(kvec, boundary);
sol = gmres(sysmat, rhs, 1e-13, 100);

% evaluate at targets

x1 = linspace(-3, 3, 400);
[xxtarg, yytarg] = meshgrid(x1, x1);
M = size(xxtarg, 1) * size(xxtarg, 2);
targets = [reshape(xxtarg, 1, M); reshape(yytarg, 1, M)];

in = chunkerinterior(chnkr, targets);
out = ~in;

uscat = chunkerkerneval(chnkr, fkern, sol, targets(:, out));

utot = uscat + planewave(kvec, targets(:, out));

% plot

maxu = max(abs(utot));
figure();
zztarg = nan(size(xxtarg)) + 0i;   % promote to complex so the masked write can hold complex values
zztarg(out) = utot;
pcolor(xxtarg, yytarg, imag(zztarg));
% `set(h, 'EdgeColor', 'none')` from the chunkie original is dropped:
% mtoc2's plot stubs return void, so the handle can't be captured.
hold('on');
plot(chnkr, 'k-');
axis('equal');
colormap(redblue(64));
caxis([-maxu, maxu]);

toc;
