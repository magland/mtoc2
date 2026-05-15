function plot(obj, style)
%PLOT plot the xy coordinates of the points of the chunker
% Simplified for mtoc2: assumes 2D, single component. The full chunkie
% version takes varargin and closes the curve via `[xs; xs(1)]`; the
% varargin splat and unknown-shape vertical concat aren't supported in
% mtoc2 v1, so we accept a single style string and drop the loop-close
% (the viewer can wrap or stroke as needed).

assert(obj.dim == 2, 'plot requires a 2D chunker');

xs = reshape(obj.r(1, :, :), [], 1);
ys = reshape(obj.r(2, :, :), [], 1);

plot(xs, ys, style);

end
