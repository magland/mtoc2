test_form_a_2d();
test_form_a_3d();
test_form_b_2d();
test_form_b_3d();
test_exact_fold_via_disp();
test_trailing_singletons();
test_runtime_path();
test_sum_of_reshape_folds();
test_reshape_zeros_chain();

function test_form_a_2d()
  disp(reshape([1 2 3 4 5 6], 2, 3));
end

function test_form_a_3d()
  disp(reshape([1 2 3 4 5 6 7 8 9 10 11 12], 2, 3, 2));
end

function test_form_b_2d()
  disp(reshape([1 2 3 4 5 6], [3, 2]));
end

function test_form_b_3d()
  disp(reshape([1 2 3 4 5 6 7 8 9 10 11 12], [2, 2, 3]));
end

function test_exact_fold_via_disp()
  % Both args fully static; mtoc2's exact tracking carries the
  % column-major Float64Array through the reshape. Codegen still
  % emits the runtime helper (no fold-at-codegen rule), so this
  % also exercises mtoc2_reshape_nd.
  disp(reshape([1 2 3 4 5 6], 2, 3));
end

function test_trailing_singletons()
  % Numbl strips trailing singletons down to 2 axes.
  % reshape(v, 2, 2, 1, 1) → shape [2, 2].
  disp(reshape([1 2 3 4], 2, 2, 1, 1));
end

function test_runtime_path()
  % Pass through a function param to drop the input's `exact`
  % (specialization arg type loses the Float64Array). Result type
  % still has the new shape, so codegen knows the dim list at
  % compile time, but the input data is opaque — the runtime
  % helper does the actual element copy.
  disp(reshape_to_2x3(zeros(2, 3) + 10));
end

function y = reshape_to_2x3(x)
  %!numbl:opaque x
  y = reshape(x, 2, 3);
end

function test_sum_of_reshape_folds()
  % Exact propagation: the inner reshape carries the Float64Array
  % through, so sum(...) over the result folds at compile time.
  % We reshape to a row vector so `sum` reduces to a scalar (numbl
  % `sum` of a matrix would return a row, which mtoc2 doesn't yet
  % support — but a 1xN reshape stays in the supported vector path).
  disp(sum(reshape([1 2 3 4 5 6], 1, 6)));
end

function test_reshape_zeros_chain()
  % Compose with zeros/ones: the input has known shape AND known
  % exact (Float64Array of zeros), so reshape propagates both.
  disp(reshape(zeros(3, 4), 2, 6));
  disp(reshape(ones(2, 3, 4), 4, 6));
end
