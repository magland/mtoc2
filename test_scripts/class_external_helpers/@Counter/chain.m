function y = chain(obj, x)
% Helper-calls-helper: `wrap` calls `inner`. Both visible inside
% this file only.
y = wrap(x) + obj.value;
end

function r = wrap(x)
r = inner(x) * 2;
end

function r = inner(x)
r = x + 100;
end
