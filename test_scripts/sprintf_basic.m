% sprintf: format kind follows the format arg's type.

% Char format → returns char; disp prints raw bytes.
c = sprintf('a=%d b=%d', 1, 2);
disp(c);

% String format → returns string; disp prints raw bytes.
s = sprintf("x = %.3f", 3.14159);
disp(s);

% sprintf with vector cycling.
v = [1, 2, 3];
t = sprintf('%d,', v);
disp(t);

% Empty format → empty result.
e = sprintf('');
disp(e);

% Use sprintf result as fprintf format-substitute (via %s).
msg = sprintf('count=%d', 42);
fprintf('result: %s\n', msg);
