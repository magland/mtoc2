function plot(obj, varargin)
%PLOT plot the xy coordinates of the points of the chunker
% Simplified: assumes 2D, single component, chunks already in order.
% Usage matches chunkie: plot(chnkr, 'b-x'), plot(chnkr, 'k-', 'LineWidth', 2), etc.

assert(obj.dim == 2, 'plot requires a 2D chunker');

xs = reshape(obj.r(1, :, :), [], 1);
ys = reshape(obj.r(2, :, :), [], 1);

% close the loop visually
xs = [xs; xs(1)];
ys = [ys; ys(1)];

plot(xs, ys, varargin{:});

end
