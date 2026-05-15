% Discretize the starfish boundary via simplified chunkerfunc.
% Stepping-stone toward ex00_starfish — exercises starfish (a more
% interesting curve than ex01's circle) end-to-end through chunkerfunc.

narms = 5;
amp = 0.5;
chnkr = chunkerfunc(@(t) starfish(t, narms, amp), 0);

fprintf('nch = %d\n', chnkr.nch);
fprintf('k   = %d\n', chnkr.k);
fprintf('total points = %d\n', chnkr.k * chnkr.nch);

% Total arclength via the smooth quadrature weights.
total_len = sum(chnkr.wts(:));
fprintf('arclength = %.10f\n', total_len);

% Sanity: every boundary node should sit on the parametric curve.
% Recompute r at each chunk's k Legendre nodes and check residual.
max_err = 0.0;
for i = 1:chnkr.nch
    for j = 1:chnkr.k
        rx = chnkr.r(1, j, i);
        ry = chnkr.r(2, j, i);
        rho = hypot(rx, ry);
        % The starfish curve has rho(t) = 1 + amp*cos(narms*t) when
        % evaluated at angle theta = atan2(y, x). For our parameterization
        % (x, y) = rho(t)*(cos(t), sin(t)), so t == theta.
        theta = atan2(ry, rx);
        rho_expected = 1 + amp*cos(narms*theta);
        err = abs(rho - rho_expected);
        if err > max_err
            max_err = err;
        end
    end
end
fprintf('max radial residual = %.3e\n', max_err);

% Adjacency: closed curve.
fprintf('adj(:,1)   = [%d %d]\n', chnkr.adj(1, 1), chnkr.adj(2, 1));
fprintf('adj(:,end) = [%d %d]\n', chnkr.adj(1, end), chnkr.adj(2, end));
