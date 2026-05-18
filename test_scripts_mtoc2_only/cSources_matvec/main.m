% Exercises `.mtoc2.js` with `exports.cSources` — the user's matrix-
% vector multiply lives in a sibling `.c` file that mtoc2 adds to
% the `cc` command. The inline `cBody` is a thin wrapper that
% marshals `mtoc2_tensor_t` into raw pointers and calls in.
A = [1, 2; 3, 4];
x = [10; 20];
y = my_matvec(A, x);
disp(y);
