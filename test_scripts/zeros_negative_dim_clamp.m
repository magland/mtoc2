% Negative runtime dims should clamp to 0 (empty tensor), not abort.
% Pre-fix: tensor_alloc_nd cast negative `long` to SIZE_MAX and
% the mul-overflow check fired with a misleading message.
n = 0;
%!numbl:opaque n
A = zeros(n - 1, 3);
disp(size(A));
B = ones(2, n - 5);
disp(size(B));
m = 4;
%!numbl:opaque m
C = zeros(m, m - 10);
disp(size(C));
