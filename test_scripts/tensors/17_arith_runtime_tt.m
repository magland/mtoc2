a = [1 2 3];
b = [10 20 30];
%!numbl:opaque a b
disp(a + b);
disp(a - b);
disp(a .* b);
disp(a ./ b);

c = [1 2; 3 4];
d = [10 20; 30 40];
%!numbl:opaque c d
disp(c + d);
disp(c - d);
disp(c .* d);
