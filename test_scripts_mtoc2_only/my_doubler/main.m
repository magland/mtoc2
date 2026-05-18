% Demonstrates a `.mtoc2.js` user function. The sibling file
% `my_doubler.mtoc2.js` defines `my_doubler(x)` via the same
% workspace-resolution path as a `.m` file — the call site below
% routes through it.
x = my_doubler(3.5);
disp(x);
y = my_doubler(my_doubler(2));
disp(y);
