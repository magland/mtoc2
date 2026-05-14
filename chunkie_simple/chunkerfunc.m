function chnkr = chunkerfunc(fcurve)
%CHUNKERFUNC simplified chunker construction for a closed 2D curve.
%
% Targets the chunkie example:
%   chnkr = chunkerfunc(@(t) ctr + rad*[cos(t(:).'); sin(t(:).')]);
%
% Compared to chunkie/chunkerfunc.m this version drops:
%   - cparams / pref arguments (defaults inlined)
%   - try/catch on the curve's output count (single-output assumed:
%     fcurve(t) returns a dim x length(t) array of positions; first
%     and second derivatives are obtained from the spectral
%     derivative matrix)
%   - the complex-number representation of the curvature test. We
%     keep the test itself, but compute the rate of tangent rotation
%     dtheta/dt = (d2y*dx - d2x*dy)/(dx^2+dy^2) directly in real
%     arithmetic.
%   - tsplits, nover, nchmin, ifrefine, chsmall, maxchunklen
%   - level-restriction mode 't' (only 'a' = arclength is supported)
%   - the closed-curve endpoint mismatch warning (would require
%     lege.matrin)
%   - chunker resize/storage indirection, vertex tracking, data rows
%
% What is kept faithful:
%   - spectral resolution test (errs0/errs on speed coefficients)
%   - coordinate resolution test (errx, erry on coordinate coefficients)
%   - level restriction (arclength mode 'a')
%   - sort by left endpoint
%   - final r/d/d2/n/wts on the k Legendre nodes

% defaults inherited from chunkie defaults
k       = 16;
nchmax  = 10000;
ta      = 0.0;
tb      = 2*pi;
eps0    = 1.0e-6;
lvlrfac = 2.1;

dim = 2;

% Legendre nodes/weights and the derivative matrices
k2 = 2 * k;
[xs,  ws,  us,  vs ] = lege.exps(k);
[xs2, ws2, u2,  v2 ] = lege.exps(k2);

% dermat maps node values to derivative-at-nodes via right-multiply on
% a row vector: (1 x k) * dermat = (1 x k) derivative values.
dermat  = (vs * [lege.derpol(us); zeros(1, k )]).';
dermat2 = (v2 * [lege.derpol(u2); zeros(1, k2)]).';

% initial chunks: one closed chunk covering [ta, tb]
ab   = zeros(2, nchmax);
adjs = zeros(2, nchmax);

ab(1, 1) = ta;
ab(2, 1) = tb;
nch = 1;
adjs(1, 1) = nch;   % closed: itself is its own neighbor
adjs(2, 1) = 1;

ifprocess = zeros(nchmax, 1);

% --- resolve to tolerance by repeated bisection ----------------------
nchnew      = nch;
maxiter_res = nchmax - nch;

for ijk = 1:maxiter_res
    ifdone = 1;
    for ich = 1:nchnew
        if ifprocess(ich) == 1
            continue
        end
        ifprocess(ich) = 1;

        a = ab(1, ich);
        b = ab(2, ich);

        ts = a + (b - a) * (xs2 + 1) / 2.0;
        r  = fcurve(ts);                       % dim x k2
        d  = r  * dermat2 * (2 / (b - a));     % dim x k2
        d2 = d  * dermat2 * (2 / (b - a));     % dim x k2

        % speed |r'(t)| at the k2 nodes
        vd = sqrt(sum(d .^ 2, 1));             % 1 x k2

        % spectral resolution test on speed
        cfs   = u2 * vd.';                     % k2 x 1
        errs0 = sum(abs(cfs(1:k)).^2, 1);
        errs  = sum(abs(cfs(k+1:k2)).^2, 1);
        err1  = sqrt(errs / errs0 / k);
        resol_speed_test = err1 > eps0;

        % spectral resolution test on coordinates
        cfsx = u2 * r(1, :).';
        cfsy = u2 * r(2, :).';
        errx = sqrt(sum(abs(cfsx(k+1:k2)).^2 / k, 1));
        erry = sqrt(sum(abs(cfsy(k+1:k2)).^2 / k, 1));
        resol_curve_test = (errx > eps0) || (erry > eps0);

        % total tangent rotation on this chunk (replaces chunkie's
        % complex-arithmetic dkappa). For a 2D curve,
        %   dtheta/dt = (d2y*dx - d2x*dy) / (dx^2 + dy^2)
        % integrate |dtheta/dt| via the k2 Gauss-Legendre quadrature
        % and require it to stay below 120 degrees per chunk.
        dkappa = (d2(2, :) .* d(1, :) - d2(1, :) .* d(2, :)) ...
                  ./ (d(1, :) .^ 2 + d(2, :) .^ 2);
        total_curve = (b - a) / 2 * (abs(dkappa) * ws2(:));
        total_curve_test = total_curve >= (2*pi) / 3;

        if resol_speed_test || resol_curve_test || total_curve_test
            % subdivide
            if nch + 1 > nchmax
                error('chunkerfunc:nchmax', ...
                    'nchmax=%d exceeded while resolving the curve', nchmax);
            end
            ifprocess(ich) = 0;
            ifdone = 0;

            iold2 = adjs(2, ich);
            adjs(2, ich) = nch + 1;
            if iold2 > 0
                adjs(1, iold2) = nch + 1;
            end
            adjs(1, nch + 1) = ich;
            adjs(2, nch + 1) = iold2;

            mid = (a + b) / 2;
            ab(2, ich)     = mid;
            ab(1, nch + 1) = mid;
            ab(2, nch + 1) = b;
            nch = nch + 1;
        end
    end
    if ifdone == 1 && nchnew == nch
        break
    end
    nchnew = nch;
end

% --- level restriction (arclength mode 'a') --------------------------
maxiter_adj = 1000;
for ijk = 1:maxiter_adj
    nchold = nch;
    ifdone = 1;
    for i = 1:nchold
        i1 = adjs(1, i);
        i2 = adjs(2, i);

        a = ab(1, i);
        b = ab(2, i);
        rlself = chunklength(fcurve, a, b, xs, ws, dermat);

        rl1 = rlself;
        rl2 = rlself;
        if i1 > 0
            rl1 = chunklength(fcurve, ab(1, i1), ab(2, i1), xs, ws, dermat);
        end
        if i2 > 0
            rl2 = chunklength(fcurve, ab(1, i2), ab(2, i2), xs, ws, dermat);
        end

        if rlself > lvlrfac * rl1 || rlself > lvlrfac * rl2
            if nch + 1 > nchmax
                error('chunkerfunc:nchmax', ...
                    'nchmax=%d exceeded during level restriction', nchmax);
            end
            ifdone = 0;

            ab2 = (a + b) / 2;
            adjs(2, i) = nch + 1;
            adjs(1, nch + 1) = i;
            adjs(2, nch + 1) = i2;
            if i2 > 0
                adjs(1, i2) = nch + 1;
            end

            ab(2, i)       = ab2;
            ab(1, nch + 1) = ab2;
            ab(2, nch + 1) = b;
            nch = nch + 1;
        end
    end
    if ifdone == 1
        break
    end
end

% --- finalize: sort by left endpoint, rebuild adjacency --------------
[~, isort] = sort(ab(1, 1:nch));
ab(:, 1:nch) = ab(:, isort);

adjs(1, 1:nch) = 0:(nch-1);
adjs(2, 1:nch) = 2:(nch+1);
% closed curve
adjs(1, 1)   = nch;
adjs(2, nch) = 1;

% --- evaluate r, d, d2 on k Legendre nodes per chunk -----------------
r_out  = zeros(dim, k, nch);
d_out  = zeros(dim, k, nch);
d2_out = zeros(dim, k, nch);

for i = 1:nch
    a = ab(1, i);
    b = ab(2, i);
    ts = a + (b - a) * (xs + 1) / 2;
    ri  = fcurve(ts);                        % dim x k
    di  = ri * dermat * (2 / (b - a));       % dim x k
    d2i = di * dermat * (2 / (b - a));       % dim x k

    h = (b - a) / 2;
    r_out (:, :, i) = reshape(ri,  dim, k);
    d_out (:, :, i) = reshape(di,  dim, k) * h;
    d2_out(:, :, i) = reshape(d2i, dim, k) * h * h;
end

% normals (2D only): rotate the unit tangent by -pi/2
dd = sqrt(d_out(1, :, :) .^ 2 + d_out(2, :, :) .^ 2);
n_out = zeros(dim, k, nch);
n_out(1, :, :) =  d_out(2, :, :) ./ dd;
n_out(2, :, :) = -d_out(1, :, :) ./ dd;

% smooth integration weights
wts = reshape(sqrt(sum(d_out .^ 2, 1)), k, nch);
wts = wts .* ws(:);

% --- pack into the chunker object -----------------------------------
chnkr = chunker();
chnkr.k   = k;
chnkr.nch = nch;
chnkr.dim = dim;
chnkr.r   = r_out;
chnkr.d   = d_out;
chnkr.d2  = d2_out;
chnkr.n   = n_out;
chnkr.adj = adjs(:, 1:nch);
chnkr.wts = wts;

end

function len = chunklength(fcurve, a, b, xs, ws, dermat)
%CHUNKLENGTH arclength of chunk [a,b] from k Legendre nodes
ts   = a + (b - a) * (xs + 1) / 2;
r    = fcurve(ts);
d    = r * dermat * (2 / (b - a));
dsdt = sqrt(sum(d .^ 2, 1));
len  = dsdt(:).' * ws(:) * (b - a) / 2;
end
