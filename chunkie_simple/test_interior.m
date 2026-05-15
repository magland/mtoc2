% Small test driver for chunkerinterior using a circle of radius 2 at (1, -0.5).
% The grid is 20 x 20 over [-3, 3]; we count interior hits and print a
% small ASCII map so numbl and mtoc2 can be compared byte-for-byte.

rad = 2; ctr = [1.0; -0.5];
circfun = @(t) ctr + rad * [cos(t(:).'); sin(t(:).')];
chnkr = chunkerfunc(circfun, 0);

fprintf('nch = %d\n', chnkr.nch);
fprintf('k   = %d\n', chnkr.k);

n = 20;
xs = linspace(-3, 3, n);
ys = linspace(-3, 3, n);
[xx, yy] = meshgrid(xs, ys);
targets = [xx(:).'; yy(:).'];

in = chunkerinterior(chnkr, targets);

% Tally interior count and compare against the analytic prediction
% (each grid cell has area (6/(n-1))^2; the circle has area pi*rad^2).
in_count = sum(in);
fprintf('inside count = %d\n', in_count);

% Estimated area: cell area * count.
cell = (6.0 / (n - 1)) ^ 2;
fprintf('area estimate = %.4f  (expected %.4f)\n', cell * in_count, pi * rad * rad);

% ASCII map.
in_grid = reshape(in, n, n);
for i = n:-1:1
    for j = 1:n
        if in_grid(i, j) > 0.5
            fprintf('#');
        else
            fprintf('.');
        end
    end
    fprintf('\n');
end

% Edge cases: empty target list should produce a 1 x 0 result.
empty_in = chunkerinterior(chnkr, zeros(2, 0));
fprintf('empty length = %d\n', length(empty_in));
