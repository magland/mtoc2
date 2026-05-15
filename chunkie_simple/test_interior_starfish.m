% Drive chunkerinterior with the starfish boundary (more nontrivial
% than the circle) to verify the winding-number test handles concave
% geometry correctly. Outputs are compared byte-for-byte across numbl
% and mtoc2.

narms = 5;
amp = 0.5;
chnkr = chunkerfunc(@(t) starfish(t, narms, amp), 0);

fprintf('nch = %d\n', chnkr.nch);
fprintf('k   = %d\n', chnkr.k);

n = 25;
xs = linspace(-1.6, 1.6, n);
ys = linspace(-1.6, 1.6, n);
[xx, yy] = meshgrid(xs, ys);
targets = [xx(:).'; yy(:).'];

in = chunkerinterior(chnkr, targets);
fprintf('inside count = %d\n', sum(in));

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
