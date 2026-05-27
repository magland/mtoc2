% cat builtin: concatenate N tensors along a static dim. Covers
% dim 1 / 2 / 3, scalar args, single-arg passthrough, drop-empty,
% and the opaque (dynamic-shape, statically-known-shape input) path.

function cat_basics()
  test_cat_dim1();
  test_cat_dim2();
  test_cat_3args_row();
  test_cat_3args_col();
  test_cat_with_scalars();
  test_cat_single();
  test_cat_3d();
  test_cat_with_empty_row();
  test_cat_with_empty_col();
  test_cat_isequal_bracket();
  test_cat_opaque_dim1();
  test_cat_opaque_dim2();
  disp('SUCCESS');
end

function test_cat_dim1()
  A = [1 2 3];
  B = [4 5 6];
  disp(cat(1, A, B));
end

function test_cat_dim2()
  A = [1; 2; 3];
  B = [4; 5; 6];
  disp(cat(2, A, B));
end

function test_cat_3args_row()
  disp(cat(2, [1 2], [3 4], [5 6]));
end

function test_cat_3args_col()
  disp(cat(1, [1 2], [3 4], [5 6]));
end

function test_cat_with_scalars()
  disp(cat(1, 1, 2, 3));
  disp(cat(2, 1, 2, 3));
end

function test_cat_single()
  disp(cat(1, [1 2; 3 4]));
end

function test_cat_3d()
  A = [1 2; 3 4];
  B = [5 6; 7 8];
  disp(cat(3, A, B));
end

function test_cat_with_empty_row()
  A = [1 2; 3 4];
  disp(cat(1, A, zeros(0, 2)));
end

function test_cat_with_empty_col()
  A = [1 2; 3 4];
  disp(cat(2, A, zeros(2, 0)));
end

function test_cat_isequal_bracket()
  A = [1 2 3];
  B = [4 5 6];
  C = cat(1, A, B);
  D = [1 2 3; 4 5 6];
  disp(isequal(C, D));
end

function test_cat_opaque_dim1()
  A = [1 2 3];
  B = [4 5 6];
  %!numbl:opaque A B
  disp(cat(1, A, B));
end

function test_cat_opaque_dim2()
  A = [1; 2; 3];
  B = [4; 5; 6];
  %!numbl:opaque A B
  disp(cat(2, A, B));
end
