function y = bar(x)
  % A packaged function that calls a sibling packaged function
  % using its qualified name. Verifies that resolution works from
  % inside a packaged file too.
  y = pkg.foo(x) + 100;
end
