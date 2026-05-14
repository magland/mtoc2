% Regression: an indexed write may insert an element whose sign
% differs from the pre-write lattice. The env must reflect the
% widened sign so downstream domain checks (sqrt / log) see the
% true post-write sign. unifySign keeps the sign tight when the
% rhs sign matches (positive into a nonneg tensor stays nonneg).
x = zeros(1, 5);
x(3) = 4;
disp(sqrt(x));

y = zeros(1, 5);
y(2:3) = [9 16];
disp(sqrt(y));
