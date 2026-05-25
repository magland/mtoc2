function y = boost(obj, x)
% Per-method-file scope: this file's `add_one` returns a different
% value than bump.m's `add_one`. Each external method sees only
% its own helpers.
y = add_one(x) + obj.value;
end

function r = add_one(x)
r = x + 10;
end
