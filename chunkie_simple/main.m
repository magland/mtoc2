% Simplified driver matching the chunkie example we're targeting.
%
% Original (chunkie):
%   rad = 2; ctr = [1.0;-0.5];
%   circfun = @(t) ctr + rad*[cos(t(:).');sin(t(:).')];
%   chnkr1 = chunkerfunc(circfun);
%   figure(1); clf
%   plot(chnkr1,'b-x'); hold on
%   quiver(chnkr1,'r')
%   axis equal tight

tic;

rad = 2; ctr = [1.0;-0.5];
circfun = @(t) ctr + rad*[cos(t(:).');sin(t(:).')];

chnkr1 = chunkerfunc(circfun);

toc;

% Print a small summary so we can sanity-check the discretization
% (e.g. compare against full chunkie). This is the part mtoc2 will
% need to reproduce byte-for-byte.
fprintf('nch = %d\n', chnkr1.nch);
fprintf('k   = %d\n', chnkr1.k);
fprintf('total points = %d\n', chnkr1.k * chnkr1.nch);

% total arclength via the smooth quadrature weights
total_len = sum(chnkr1.wts(:));
fprintf('arclength = %.10f\n', total_len);
fprintf('expected  = %.10f  (2*pi*rad)\n', 2*pi*rad);

% distance from each node to the centre should equal rad
rx = reshape(chnkr1.r(1, :, :), [], 1) - ctr(1);
ry = reshape(chnkr1.r(2, :, :), [], 1) - ctr(2);
radii = sqrt(rx .^ 2 + ry .^ 2);
fprintf('radius range = [%.12f, %.12f]\n', min(radii), max(radii));

% adjacency: closed curve, so first chunk's left neighbour is the last
fprintf('adj(:,1)   = [%d %d]\n', chnkr1.adj(1, 1), chnkr1.adj(2, 1));
fprintf('adj(:,end) = [%d %d]\n', chnkr1.adj(1, end), chnkr1.adj(2, end));

% arclength of each chunk should be 2*pi*rad / nch (chunks equal for a circle)
chunk_lens = sum(chnkr1.wts, 1);
fprintf('per-chunk arclengths:');
fprintf(' %.10f', chunk_lens);
fprintf('\n');
fprintf('expected each      : %.10f\n', 2*pi*rad / chnkr1.nch);

figure(1)
clf
plot(chnkr1,'b-x')
hold on
quiver(chnkr1,'r')
axis equal tight
