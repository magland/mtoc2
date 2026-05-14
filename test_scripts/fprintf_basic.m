% Basic fprintf cases — match numbl byte-for-byte.

% Plain literals, no args.
fprintf('hello\n');
fprintf('no newline ');
fprintf('!\n');

% Integer args.
fprintf('nch = %d\n', 7);
fprintf('a = %d, b = %d, c = %d\n', 1, 2, 3);

% Float args with precision.
x = 3.14159265358979;
fprintf('pi = %.5f\n', x);
fprintf('pi = %.12f\n', x);
fprintf('pi = %g\n', x);

% Vector cycled across format spec.
v = [1.5, 2.5, 3.5];
fprintf(' %.2f', v);
fprintf('\n');

% String / char in %s.
fprintf('greet: %s!\n', 'world');
fprintf('greet: %s!\n', "world");

% Mixed numeric + text.
fprintf('item=%s n=%d\n', 'x', 42);

% Negative + zero-pad + width.
fprintf('[%5d]\n', 7);
fprintf('[%-5d]\n', 7);
fprintf('[%05d]\n', 7);
fprintf('[%+d]\n', 12);
