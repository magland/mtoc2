% Basic string literal + disp + assign + var read.

disp("hello");
disp("a");
disp("");

% Assign a string to a variable, then disp the variable.
s = "world";
disp(s);

% Reassign — exercises the assign helper's free-then-move path.
s = "second";
disp(s);

% Single character.
c = "x";
disp(c);
