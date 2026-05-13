disp(sumsq([3 4]));
disp(triangular_sum(10));

function y = sumsq(v)
  s = sum(v);
  y = s * s;
end

function s = triangular_sum(n)
  s = sum([1 2 3 4 5 6 7 8 9 10]);
  s = s + n - n;
end
