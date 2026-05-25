% addpath — a sibling file in the addpath'd dir has a parse error.
% Numbl warns and skips it (so other files in the same dir still
% resolve), and mtoc2 matches that behavior. The warning lands on
% stderr; stdout below is the only thing the cross-runner compares.

addpath('lib');

y = ok_helper(7);
disp(y);
