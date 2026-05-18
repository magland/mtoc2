% Smoke test for the mtoc2-only runner. Uses only builtins that also
% run through numbl, so the .expected baseline is portable. Once
% mtoc2-only features (user-defined .mtoc2.js builtins, etc.) land,
% this directory will hold tests that exercise them — and those tests
% cannot live in test_scripts/ because numbl has no counterpart.
x = 1 + 2;
disp(x);
