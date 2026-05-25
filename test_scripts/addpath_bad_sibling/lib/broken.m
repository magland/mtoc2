function y = broken(x)
% Intentional syntax error — unterminated bracket. Numbl skips this
% file with a warning; mtoc2 must do the same so a single bad file
% in an addpath'd dir doesn't poison the run.
y = [1 2 3
end
