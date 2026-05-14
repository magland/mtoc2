% Regression: a tensor initialized with a literal AND reassigned inside
% a loop. Before "always-materialize" the initial assignment was elided
% (TensorLit-RHS marked non-materializing), so the loop body read NULL
% pointers from the empty-tensor pre-declaration and produced NaN.

a = [1 2 3];
for j = 1:2
  a = a + 1;
end
disp(a);

% Same pattern with multiplication.
b = [10 20];
for j = 1:3
  b = 2 * b;
end
disp(b);

% Matrix variant.
m = [1 2; 3 4];
for j = 1:2
  m = m + 1;
end
disp(m);

% Tensor exact at start, opaque mid-flight, then mutated in loop.
c = [100 200 300];
%!numbl:opaque c
for j = 1:2
  c = c + j;
end
disp(c);
