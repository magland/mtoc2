function quiver(obj, color)
%QUIVER quiver plot of chunker normals
% Simplified for mtoc2: takes a single color spec (no varargin).

assert(obj.dim == 2, 'quiver requires a 2D chunker');

xs = reshape(obj.r(1, :, :), [], 1);
ys = reshape(obj.r(2, :, :), [], 1);
u  = reshape(obj.n(1, :, :), [], 1);
v  = reshape(obj.n(2, :, :), [], 1);

quiver(xs, ys, u, v, color);

end
