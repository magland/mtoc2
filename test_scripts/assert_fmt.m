% assert with various message shapes. All conds truthy → no runtime
% failure; cross-runner sees identical empty stderr on both sides.

% Bare assertion.
assert(1);
assert(2 > 1);

% Literal message.
assert(3 > 2, 'three is greater');

% printf-style message (cond is truthy, but the code path compiles).
n = 5;
assert(n > 0, 'expected positive n, got %d', n);

% printf-style with multiple args.
a = 1.5;
b = 2.5;
assert(a < b, 'a=%.1f, b=%.1f', a, b);

% Opaque message var (no exact at compile time).
flag = 1;
msg = 'dynamic message';
if flag > 0
  assert(1, msg);
end

disp('done');
