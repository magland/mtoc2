function quiver(obj, varargin)
%QUIVER quiver plot of chunker normals
% Simplified: assumes 2D.

assert(obj.dim == 2, 'quiver requires a 2D chunker');

xs = reshape(obj.r(1, :, :), [], 1);
ys = reshape(obj.r(2, :, :), [], 1);
u  = reshape(obj.n(1, :, :), [], 1);
v  = reshape(obj.n(2, :, :), [], 1);

quiver(xs, ys, u, v, varargin{:});

end
