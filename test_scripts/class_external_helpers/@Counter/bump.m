function y = bump(obj, x)
% External method file with a local helper. The helper is scoped
% to THIS file: a sibling external method file may define a
% function with the same name without conflict.
y = add_one(x) + obj.value;
end

function r = add_one(x)
r = x + 1;
end
