a = [1 2 3 4 5];
%!numbl:opaque a
disp(sum(a));

b = [1; 2; 3; 4];
%!numbl:opaque b
disp(sum(b));

c = [1.5 2.5 3.5];
%!numbl:opaque c
disp(sum(c));

% sum of an arith result (intermediate tensor materialized via hoist)
d = [1 2 3];
e = [10 20 30];
%!numbl:opaque d e
disp(sum(d + e));
disp(sum(2 * d));
