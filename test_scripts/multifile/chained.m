function y = chained(x)
  % Calls a sibling workspace function. Exercises cross-file calls
  % originating from a workspace function (not the main file).
  y = double_it(x) + helper(x);
end
