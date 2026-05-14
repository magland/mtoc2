function y = foo(x)
  % Same source-level name as pkg.foo. The specialization key is
  % salted by the defining file, so this gets a distinct C mangling.
  y = x * 1000 - 3;
end
