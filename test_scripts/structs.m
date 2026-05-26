test_struct_basic();
test_struct_field_read();
test_struct_field_write();
test_struct_disp_scalar();
test_struct_disp_row_vec();
test_struct_disp_matrix();
test_struct_tensor_field();
test_struct_in_function();
test_struct_in_for();
test_struct_nested();
test_struct_field_indexed_write();
test_struct_field_slice_write();
test_struct_field_3d_write();

function test_struct_basic()
  s = struct('x', 1, 'y', 2);
  disp(s.x);
  disp(s.y);
end

function test_struct_field_read()
  s = struct('a', 7, 'b', 11);
  z = s.a + s.b;
  disp(z);
end

function test_struct_field_write()
  s = struct('x', 1, 'y', 2);
  s.x = 99;
  disp(s.x);
  disp(s.y);
end

function test_struct_disp_scalar()
  s = struct('x', 1, 'y', 2.5);
  disp(s);
end

function test_struct_disp_row_vec()
  s = struct('a', [1 2 3], 'b', 7);
  disp(s);
end

function test_struct_disp_matrix()
  s = struct('a', [1 2; 3 4], 'b', 7);
  disp(s);
end

function test_struct_tensor_field()
  s = struct('data', [1 2 3 4 5]);
  disp(sum(s.data));
end

function test_struct_in_function()
  s = make_pair(3, 4);
  disp(s.x);
  disp(s.y);
end

function test_struct_in_for()
  total = 0;
  for k = 1:5
    s = struct('v', k);
    total = total + s.v;
  end
  disp(total);
end

function test_struct_nested()
  inner = struct('a', 1, 'b', 2);
  outer = struct('inner', inner, 'c', 3);
  disp(outer.inner.a);
  disp(outer.inner.b);
  disp(outer.c);
end

function s = make_pair(a, b)
  s = struct('x', a, 'y', b);
end

function test_struct_field_indexed_write()
  % Scalar slot write into a struct's tensor field.
  s = struct('M', zeros(2, 3));
  s.M(1, 2) = 99;
  s.M(2, 3) = 7;
  disp(s.M);
end

function test_struct_field_slice_write()
  % Colon / range / row + col slice writes through a struct field.
  s = struct('M', zeros(2, 3));
  s.M(:, 2) = [10; 20];
  s.M(1, :) = [1, 2, 3];
  disp(s.M);
end

function test_struct_field_3d_write()
  % 3-D field: layer-write via colon-colon-scalar. Read back the
  % whole field — struct field reads with index args are a separate
  % gap in lowering (`s.field(args)` is only wired for class
  % instances today).
  s = struct('A', zeros(2, 2, 2));
  s.A(:, :, 1) = [1, 2; 3, 4];
  s.A(:, :, 2) = [5, 6; 7, 8];
  disp(s.A);
end

