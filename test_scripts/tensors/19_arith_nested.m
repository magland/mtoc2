a = [1 2 3];
b = [10 20 30];
c = [100 200 300];
%!numbl:opaque a b c
disp(a + b + c);
disp(a - b + c);
disp(a .* b + c);
disp((a + b) .* c);
disp(a + 2 * b);
disp(-a + b);
