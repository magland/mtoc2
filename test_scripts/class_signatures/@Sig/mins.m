function [a, b, c] = mins(obj, x, y, z)
  a = min(min(x, y), z) + obj.base;
  b = max(max(x, y), z) + obj.base;
  c = obj.base;
end
