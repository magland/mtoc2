% A `sum(t)` where `t`'s shape is unknown at compile time (e.g. a
% tensor field on a struct/class with declared `>1 x ?`) used to
% silently emit `mtoc2_sum`, which collapses every element to one
% scalar regardless of shape. Numbl's `sum(M)` for a 2-D matrix
% returns a row vector — divergence. mtoc2 now requires evidence
% that the input is a vector (one of the dims is statically `one`)
% and rejects unknown-shape matrix inputs at lowering with
% UnsupportedConstruct, matching the existing rejection of
% statically-known matrix inputs.
%
% This script just exercises the supported cases to confirm they
% still work after the tightening; the unsupported case is covered
% by tests/sum_unknown_shape.test.ts (vitest, since translate-time
% errors don't go through the cross-runner).

test_sum_known_row_vector();
test_sum_known_col_vector();
test_sum_unknown_shape_row_vector_field();

function test_sum_known_row_vector()
  v = [1 2 3 4];
  disp(sum(v));
end

function test_sum_known_col_vector()
  % Build a column vector via slice into a column.
  M = zeros(3, 1);
  M(1) = 10; M(2) = 20; M(3) = 30;
  disp(sum(M));
end

function test_sum_unknown_shape_row_vector_field()
  % Field declared with at least one `one` axis stays accepted.
  s = struct('v', [1 2 3 4 5]);
  disp(sum(s.v));
end
