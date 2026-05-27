function triangular_basics()
  test_triu_default();
  test_tril_default();
  test_triu_k_pos();
  test_triu_k_neg();
  test_tril_k_pos();
  test_tril_k_neg();
  test_triu_square();
  test_tril_square();
  test_triu_tall();
  test_tril_tall();
  test_triu_wide();
  test_tril_wide();
  test_triu_scalar();
  test_tril_scalar();
  test_triu_scalar_k_pos();
  test_tril_scalar_k_neg();
  test_after_opaque();
  disp('SUCCESS');
end

function test_triu_default()
  % 3x3, default k=0: zero strictly-below-diagonal.
  disp(triu([1 2 3; 4 5 6; 7 8 9]));
end

function test_tril_default()
  % 3x3, default k=0: zero strictly-above-diagonal.
  disp(tril([1 2 3; 4 5 6; 7 8 9]));
end

function test_triu_k_pos()
  % 3x3, k=1: keep first superdiagonal and above.
  disp(triu([1 2 3; 4 5 6; 7 8 9], 1));
end

function test_triu_k_neg()
  % 3x3, k=-1: keep first subdiagonal and above.
  disp(triu([1 2 3; 4 5 6; 7 8 9], -1));
end

function test_tril_k_pos()
  % 3x3, k=1: keep first superdiagonal and below.
  disp(tril([1 2 3; 4 5 6; 7 8 9], 1));
end

function test_tril_k_neg()
  % 3x3, k=-1: keep first subdiagonal and below.
  disp(tril([1 2 3; 4 5 6; 7 8 9], -1));
end

function test_triu_square()
  % 4x4 to exercise more rows / cols.
  disp(triu([1 2 3 4; 5 6 7 8; 9 10 11 12; 13 14 15 16]));
end

function test_tril_square()
  disp(tril([1 2 3 4; 5 6 7 8; 9 10 11 12; 13 14 15 16]));
end

function test_triu_tall()
  % 4x2 tall matrix.
  disp(triu([1 2; 3 4; 5 6; 7 8]));
end

function test_tril_tall()
  disp(tril([1 2; 3 4; 5 6; 7 8]));
end

function test_triu_wide()
  % 2x4 wide matrix.
  disp(triu([1 2 3 4; 5 6 7 8]));
end

function test_tril_wide()
  disp(tril([1 2 3 4; 5 6 7 8]));
end

function test_triu_scalar()
  % Scalar input, k=0: keep (kept).
  disp(triu(7));
end

function test_tril_scalar()
  disp(tril(7));
end

function test_triu_scalar_k_pos()
  % Scalar with k=1: predicate j-i >= 1 → 0-0 = 0 < 1 → drop, expect 0.
  disp(triu(7, 1));
end

function test_tril_scalar_k_neg()
  % Scalar with k=-1: predicate i-j >= 1 → 0 < 1 → drop, expect 0.
  disp(tril(7, -1));
end

function test_after_opaque()
  % Force the runtime path (no exact-fold) for both helpers.
  a = [1 2 3; 4 5 6; 7 8 9];
  %!numbl:opaque a
  disp(triu(a));
  disp(tril(a));
  disp(triu(a, 1));
  disp(tril(a, -1));
end
