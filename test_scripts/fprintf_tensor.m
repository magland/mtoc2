% fprintf on tensor args — column-major flatten + format cycling.

% Single-arg row, cycled.
v = [10, 20, 30, 40];
fprintf('v[%d]=%d\n', 1:4, v);
fprintf('\n');

% Column vector.
c = [1.0; 2.0; 3.0];
fprintf('%.3f\n', c);

% Matrix — column-major flatten.
M = [1 2 3; 4 5 6];
fprintf('%d ', M);
fprintf('\n');

% Mix: scalar then tensor.
fprintf('first=%d then %d', 100, [7, 8, 9]);
fprintf('\n');

% %g on floats.
xs = [0.0, 0.5, 1e-5, 1e10];
fprintf('%g\n', xs);

% Empty tensor — should produce no output (skipped).
e = zeros(0, 3);
fprintf('before\n');
fprintf('%d\n', e);
fprintf('after\n');
