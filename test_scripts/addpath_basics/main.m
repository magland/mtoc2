% addpath — workspace lookup pulls helpers out of the addpath'd dir.
% mtoc2 chdir's into the script's dir before running (matching numbl's
% `run` behavior), so `addpath('lib')` resolves to `<scriptDir>/lib`.
% Sibling scanning does NOT auto-descend into a plain `lib/` subdir
% (only `+pkg/`, `@class/`, and `private/` get walked), so the calls
% below only work because of the addpath statement.

addpath('lib');

y = helper(5);
disp(y);

z = also_in_lib(3, 4);
disp(z);
