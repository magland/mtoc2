% Indexing & slicing — scalar reads/writes, range/colon slice reads/writes,
% range-as-value, end keyword, loop-body widening, post-write exact refresh,
% and indexed-write sign widening.
%
% mtoc2-test-xfail-interpreter: bare ':' / multi-slot LogicalMask paths not yet wired
% mtoc2-test-xfail-js-aot: emitJs IndexSlice multi-slot 'LogicalMask' not yet wired

test_index_read_2d();
test_index_read_3d();
test_index_read_linear();
test_index_write_2d();
test_index_write_3d();
test_index_write_then_read();
test_index_end_linear();
test_index_end_perdim();
test_index_in_loop();

test_slice_read_colon_linear();
test_slice_read_range_linear();
test_slice_read_perdim_colon();
test_slice_read_perdim_range();
test_slice_read_perdim_mixed();
test_slice_read_3d_page();
test_slice_write_colon();
test_slice_write_range_scalar_rhs();
test_slice_write_range_var_rhs();
test_slice_write_perdim();
test_slice_write_3d_page_var_rhs();
test_slice_with_end();
test_slice_write_then_read();

test_range_assign();
test_range_step();
test_range_negative_step();
test_range_as_rhs_of_slice();
test_range_arithmetic();
test_range_empty();

test_scalar_write_invalidates_sum();
test_slice_write_invalidates_sum();
test_scalar_write_invalidates_disp();
test_scalar_read_exact_propagates();
test_scalar_write_exact_refresh();

test_index_write_in_for_strips_exact();
test_slice_write_in_for_strips_exact();
test_index_write_in_while_strips_exact();

test_indexed_write_widens_sign();

test_index_vec_gather_2d();
test_index_vec_gather_3d();
test_index_vec_gather_runtime();
test_logical_mask_perdim_cols();
test_logical_mask_perdim_rows();
test_logical_mask_perdim_3d();
test_logical_mask_linear_row();
test_logical_mask_linear_col();
test_logical_mask_linear_matrix();
test_logical_mask_inline_expr();
test_logical_mask_write_scalar();
test_logical_mask_write_vector();
test_logical_mask_write_in_loop();
test_sort_row_vec();
test_sort_col_vec();
test_sort_two_output();
test_sort_then_gather();

test_complex_scalar_read();
test_complex_scalar_write();
test_complex_slice_read();
test_complex_slice_write();
test_complex_index_in_loop();

% -------- scalar index --------

function test_index_read_2d()
  m = zeros(2, 3);
  m(1, 1) = 1;
  m(2, 1) = 2;
  m(1, 2) = 3;
  m(2, 2) = 4;
  m(1, 3) = 5;
  m(2, 3) = 6;
  disp(m(1, 1));
  disp(m(2, 1));
  disp(m(1, 2));
  disp(m(2, 3));
end

function test_index_read_3d()
  t = zeros(2, 3, 4);
  t(1, 2, 3) = 7;
  t(2, 3, 4) = 9;
  disp(t(1, 2, 3));
  disp(t(2, 3, 4));
  disp(t(1, 1, 1));
end

function test_index_read_linear()
  m = zeros(2, 3);
  m(2, 1) = 100;
  m(1, 2) = 200;
  m(2, 3) = 300;
  % column-major: linear index 1 -> (1,1), 2 -> (2,1), 3 -> (1,2), ...
  disp(m(1));
  disp(m(2));
  disp(m(3));
  disp(m(6));
end

function test_index_write_2d()
  m = zeros(3, 3);
  for k = 1:3
    m(k, k) = k;
  end
  disp(m);
end

function test_index_write_3d()
  t = zeros(2, 2, 2);
  t(1, 1, 1) = 1;
  t(2, 2, 2) = 8;
  t(1, 2, 1) = 3;
  disp(t);
end

function test_index_write_then_read()
  v = zeros(1, 5);
  v(3) = 42;
  disp(v(3));
  v(3) = v(3) + 1;
  disp(v(3));
end

function test_index_end_linear()
  v = zeros(1, 5);
  v(5) = 99;
  v(4) = 88;
  disp(v(end));
  disp(v(end - 1));
end

function test_index_end_perdim()
  m = zeros(3, 4);
  m(3, 4) = 12;
  m(3, 2) = 5;
  disp(m(end, end));
  disp(m(end, 2));
end

function test_index_in_loop()
  v = zeros(1, 5);
  for k = 1:5
    v(1, k) = k * 10;
  end
  disp(v);
end

% -------- slice index --------

function test_slice_read_colon_linear()
  m = zeros(2, 3);
  m(1, 1) = 1; m(2, 1) = 2;
  m(1, 2) = 3; m(2, 2) = 4;
  m(1, 3) = 5; m(2, 3) = 6;
  v = m(:);
  disp(v);
end

function test_slice_read_range_linear()
  v = zeros(1, 6);
  for k = 1:6
    v(k) = k * 10;
  end
  w = v(2:5);
  disp(w);
end

function test_slice_read_perdim_colon()
  m = zeros(3, 4);
  for r = 1:3
    for c = 1:4
      m(r, c) = r + c * 10;
    end
  end
  col2 = m(:, 2);
  disp(col2);
  row3 = m(3, :);
  disp(row3);
end

function test_slice_read_perdim_range()
  m = zeros(4, 4);
  for r = 1:4
    for c = 1:4
      m(r, c) = r + c * 10;
    end
  end
  sub = m(2:3, 2:3);
  disp(sub);
end

function test_slice_read_perdim_mixed()
  t = zeros(2, 3, 4);
  for i = 1:2
    for j = 1:3
      for k = 1:4
        t(i, j, k) = i * 100 + j * 10 + k;
      end
    end
  end
  slice = t(:, 2, :);
  disp(slice);
end

function test_slice_read_3d_page()
  t = zeros(2, 3, 4);
  for i = 1:2
    for j = 1:3
      for k = 1:4
        t(i, j, k) = i + j * 10 + k * 100;
      end
    end
  end
  page = t(:, :, 2);
  disp(page);
end

function test_slice_write_colon()
  v = zeros(1, 4);
  v(:) = 7;
  disp(v);
end

function test_slice_write_range_scalar_rhs()
  v = zeros(1, 6);
  v(2:5) = 9;
  disp(v);
end

function test_slice_write_range_var_rhs()
  v = zeros(1, 6);
  w = zeros(1, 4);
  for k = 1:4
    w(k) = k;
  end
  v(2:5) = w;
  disp(v);
end

function test_slice_write_perdim()
  m = zeros(3, 3);
  m(2, :) = 5;
  disp(m);
end

function test_slice_write_3d_page_var_rhs()
  t = zeros(2, 3, 4);
  page = zeros(2, 3);
  for r = 1:2
    for c = 1:3
      page(r, c) = r + c * 10;
    end
  end
  t(:, :, 2) = page;
  disp(t);
end

function test_slice_with_end()
  v = zeros(1, 6);
  for k = 1:6
    v(k) = k;
  end
  w = v(2:end);
  disp(w);
  x = v(1:end - 1);
  disp(x);
end

function test_slice_write_then_read()
  v = zeros(1, 5);
  v(2:4) = 8;
  w = v(2:4);
  disp(w);
end

% -------- range as value --------

function test_range_assign()
  v = 1:5;
  disp(v);
end

function test_range_step()
  v = 1:2:10;
  disp(v);
end

function test_range_negative_step()
  v = 10:-1:1;
  disp(v);
end

function test_range_as_rhs_of_slice()
  n = 4;
  adjs = zeros(1, n);
  adjs(1, 1:n) = 0:(n - 1);
  disp(adjs);
end

function test_range_arithmetic()
  v = (1:5) * 2;
  disp(v);
end

function test_range_empty()
  v = 5:1;
  disp(numel(v));
end

% -------- post-indexed-write exact refresh --------

function test_scalar_write_invalidates_sum()
  x = zeros(1, 4);
  x(1) = 5;
  if sum(x) > 0
    disp(11);
  else
    disp(22);
  end
end

function test_slice_write_invalidates_sum()
  x = zeros(1, 4);
  x(2:3) = [7 8];
  if sum(x) > 10
    disp(33);
  else
    disp(44);
  end
end

function test_scalar_write_invalidates_disp()
  x = ones(1, 3);
  x(2) = 99;
  disp(x);
end

% Scalar index-read of an exact-tracked tensor propagates the element
% value into the result type. Without that, the downstream `zeros(r, c)`
% would fail with "dim vector must be statically known". numbl sees the
% same `disp` output; mtoc2 silently routes through static folding.
function test_scalar_read_exact_propagates()
  x = zeros(4, 5);
  sz = size(x);
  r = sz(1) - 1;
  c = sz(2);
  y = zeros(r, c);
  disp(size(y, 1));
  disp(size(y, 2));
end

% Scalar indexed-write with an exact RHS and exact index refreshes
% (rather than strips) the base tensor's exact data. Downstream
% `zeros(sz)` then folds. Matches `lege.derpol`'s `sz(1) = max(...)`
% pattern.
function test_scalar_write_exact_refresh()
  sz = [4, 5];
  sz(1) = max(sz(1) - 1, 0);
  y = zeros(sz);
  disp(size(y, 1));
  disp(size(y, 2));
end

% -------- loop-body widening on indexed writes --------

function test_index_write_in_for_strips_exact()
  x = zeros(1, 4);
  for k = 1:4
    if sum(x) > 5
      disp(101);
    else
      disp(202);
    end
    x(k) = k;
  end
end

function test_slice_write_in_for_strips_exact()
  x = zeros(1, 4);
  for k = 1:2
    if sum(x) > 5
      disp(303);
    else
      disp(404);
    end
    x(2*k - 1 : 2*k) = [10 20];
  end
end

function test_index_write_in_while_strips_exact()
  x = zeros(1, 3);
  k = 1;
  while k <= 3
    if sum(x) > 5
      disp(505);
    else
      disp(606);
    end
    x(k) = 100;
    k = k + 1;
  end
end

% -------- indexed-write sign widening --------

function test_indexed_write_widens_sign()
  x = zeros(1, 5);
  x(3) = 4;
  disp(sqrt(x));

  y = zeros(1, 5);
  y(2:3) = [9 16];
  disp(sqrt(y));
end

% -------- per-axis vector-of-indices gather (read) --------

function test_index_vec_gather_2d()
  M = [1 2 3 4; 5 6 7 8; 9 10 11 12];
  idx = [3 1 4 2];
  disp(M(:, idx));            % 3x4 permuted-columns
  disp(M([2 1 3], :));        % 3x4 permuted-rows
end

function test_index_vec_gather_3d()
  T = zeros(2, 3, 4);
  for k = 1:4
    T(:, :, k) = [k k+1 k+2; k+10 k+11 k+12];
  end
  idx = [4 1 2];
  disp(T(:, :, idx));         % 2x3x3 permuted along the page axis
end

function test_index_vec_gather_runtime()
  M = [10 20 30 40 50; 60 70 80 90 100];
  idx = [5 3 1];
  %!numbl:opaque M idx
  disp(M(:, idx));
end

% -------- logical-mask indexing --------

% Per-axis read: pick columns where mask is true. Mask hoisted via
% double-not so its type is `logical[1x4]`.
function test_logical_mask_perdim_cols()
  M = [1 2 3 4; 5 6 7 8];
  mask = ~[0 1 1 0];
  disp(M(:, mask));
end

% Per-axis read: pick rows where mask is true.
function test_logical_mask_perdim_rows()
  M = [1 2 3; 4 5 6; 7 8 9];
  rmask = ~[0; 1; 0];
  disp(M(rmask, :));
end

% Per-axis logical mask along the page axis of a 3-D tensor.
function test_logical_mask_perdim_3d()
  T = zeros(2, 3, 4);
  for k = 1:4
    T(:, :, k) = [k k+1 k+2; k+10 k+11 k+12];
  end
  pmask = ~[0 1 0 1];
  disp(T(:, :, pmask));
end

% Linear single-slot mask on a row vector → row vector result.
function test_logical_mask_linear_row()
  a = [10 20 30 40 50];
  mask = ~[1 0 1 0 1];
  disp(a(mask));
end

% Linear single-slot mask on a column vector → column vector result.
function test_logical_mask_linear_col()
  c = [10; 20; 30; 40; 50];
  mask = ~[1 0 1 0 1];
  disp(c(mask));
end

% Linear single-slot mask on a matrix → column vector (column-major flatten).
function test_logical_mask_linear_matrix()
  M = [1 2; 3 4; 5 6];
  mask = ~[1 0; 0 1; 1 0];
  disp(M(mask));
end

% Mask built inline (no named variable) — exercises the ANF hoist
% inside lowerIndexSlice / lowerIndexSliceStore for a non-Var slot expr.
function test_logical_mask_inline_expr()
  a = [10 20 30 40 50];
  disp(a(~[0 1 0 1 0]));
  a(~[1 0 1 0 1]) = 0;
  disp(a);
end

% Scalar broadcast write through a linear logical mask.
function test_logical_mask_write_scalar()
  v = [1 2 3 4 5 6];
  mask = ~[0 0 1 0 1 0];
  v(mask) = -1;
  disp(v);
end

% Vector RHS write through a linear logical mask. RHS length must
% equal sum(mask); both numbl and mtoc2 surface a runtime error on
% mismatch.
function test_logical_mask_write_vector()
  v = [10 20 30 40 50];
  mask = ~[0 1 0 0 1];
  v(mask) = [100 200 300];
  disp(v);
end

% Logical-mask write in a loop body — exercises the env-widening /
% exact-strip path through `collectAssignedNames`.
function test_logical_mask_write_in_loop()
  v = zeros(1, 5);
  for k = 1:5
    v(k) = k;
  end
  mask = ~[1 0 0 1 0];
  for k = 1:3
    v(mask) = k * 10;
  end
  disp(v);
end

% -------- sort (multi-output builtin via [v, i] = sort(x)) --------

function test_sort_row_vec()
  a = [3 1 4 1 5 9 2 6];
  disp(sort(a));
end

function test_sort_col_vec()
  a = [3; 1; 4; 1; 5; 9; 2; 6];
  %!numbl:opaque a
  disp(sort(a));
end

function test_sort_two_output()
  a = [3 1 4 1 5 9 2 6];
  %!numbl:opaque a
  [v, i] = sort(a);
  disp(v);
  disp(i);
end

function test_sort_then_gather()
  % Chunkie pattern: sort gives a permutation, used to reorder
  % another tensor's columns via vector-of-indices gather.
  ab  = [4 2 6 1 3 5; 14 12 16 11 13 15];
  key = ab(1, :);
  %!numbl:opaque ab key
  [~, isort] = sort(key);
  disp(ab(:, isort));
end

% -------- complex indexing --------

% Scalar reads of a complex tensor element: linear and per-axis.
function test_complex_scalar_read()
  a = [1+1i, 2+2i, 3+3i; 4+4i, 5+5i, 6+6i];
  disp(a(1, 1));
  disp(a(2, 3));
  disp(a(4));  % linear column-major
  % Same with an opaque base (no fold).
  %!numbl:opaque a
  disp(a(1, 2));
  disp(a(2, 2));
end

% Scalar writes of a complex tensor element. Mixed complex/real RHS
% into a complex base: real RHS writes imag=0.
function test_complex_scalar_write()
  b = [0i, 0i, 0i];
  b(1) = 1 + 1i;
  b(2) = 5;          % real RHS into complex base → imag = 0
  b(3) = 2 - 3i;
  disp(b);
end

% Slice reads of a complex tensor.
function test_complex_slice_read()
  a = [1+1i, 2+2i, 3+3i; 4+4i, 5+5i, 6+6i];
  disp(a(:, 1));      % column
  disp(a(1, :));      % row
  disp(a(:));         % linear → column vec
  disp(a(2, 1:2));    % range
  % opaque
  %!numbl:opaque a
  disp(a(:, 2));
end

% Slice writes into a complex tensor.
function test_complex_slice_write()
  c = [0i, 0i, 0i, 0i, 0i];
  c(2:4) = [1+1i, 2+2i, 3+3i];
  disp(c);
  % Scalar broadcast across all slots.
  c(:) = 0;
  disp(c);
  c(:) = 7 - 7i;
  disp(c);
  % Real-tensor RHS into complex base via slice.
  c = [0i, 0i, 0i];
  c(:) = [10, 20, 30];
  disp(c);
end

% Loop-driven complex indexed write — exercises the env-widening
% / exact-strip path with an isComplex'd base.
function test_complex_index_in_loop()
  z = [0i, 0i, 0i, 0i];
  for k = 1:4
    z(k) = k + k*1i;
  end
  disp(z);
end
