function [a, b] = pair(x)
  % Two-output package function — exercises multi-assign of a
  % `MethodCall`-shaped RHS (i.e. `[a, b] = pkg.pair(...)`).
  a = x + 1;
  b = x * 2;
end
