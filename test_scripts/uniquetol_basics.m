% uniquetol: first-occurrence dedup with absolute tolerance.

test_row_vector();
test_col_vector();
test_default_tol();
test_nan_preservation();
test_transitive_chaining();
test_empty();
test_scalar();
test_runtime_inputs();

function test_row_vector()
  % Row in → row out, length 3, preserving first-occurrence order.
  x = [1.0, 1.0000001, 2.0, 2.0000005, 3.0];
  disp(uniquetol(x, 1e-5));
end

function test_col_vector()
  % Column in → column out, NOT sorted.
  x = [3.0; 1.0; 2.0; 1.0001; 3.0001];
  disp(uniquetol(x, 1e-3));
end

function test_default_tol()
  % No second arg → default tol of 1e-6.
  disp(uniquetol([1.0, 1.0 + 1e-9, 1.0 + 1e-3]));
end

function test_nan_preservation()
  % NaN is never within tol of anything (including itself), so each
  % NaN survives as its own entry.
  disp(uniquetol([1.0, NaN, 1.0, NaN, 2.0], 1e-6));
end

function test_transitive_chaining()
  % Pairwise-against-running-list lets 1.8 collapse into 0 through
  % the 0.6 / 1.2 chain.
  disp(uniquetol([0.0, 0.6, 1.2, 1.8], 0.7));
end

function test_empty()
  % `[]` → column [0, 1] empty.
  disp(size(uniquetol([], 1e-3)));
end

function test_scalar()
  % Scalar is 1×1 → row-shaped output of length 1.
  disp(uniquetol(5.0, 0.1));
end

function test_runtime_inputs()
  x = [1.0, 1.0000001, 2.0, 2.0000005, 3.0];
  t = 1e-5;
  %!numbl:opaque x t
  disp(uniquetol(x, t));
end
