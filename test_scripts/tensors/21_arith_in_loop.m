a = [1 2 3];
%!numbl:opaque a
for k = 1:3
  disp(a + k);
  disp(k * a);
end

s = 0;
for k = 1:5
  s = s + sum(a);
end
disp(s);
