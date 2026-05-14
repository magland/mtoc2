test_zeros_3d_disp();
test_ones_3d_disp();
test_zeros_4d_size_via_numel();
test_length_3d();
test_nd_arith_tt();
test_nd_arith_ts();
test_nd_arith_st();
test_nd_pass_to_func();
test_nd_struct_field();
test_nd_class_field();
test_zeros_n_square();
test_zeros_after_opaque();

function test_zeros_3d_disp()
  disp(zeros(2, 3, 4));
end

function test_ones_3d_disp()
  disp(ones(2, 3, 4));
end

function test_zeros_4d_size_via_numel()
  disp(numel(zeros(2, 3, 4, 5)));
end

function test_length_3d()
  disp(length(zeros(2, 3, 4)));
end

function test_nd_arith_tt()
  a = zeros(2, 3, 4);
  b = ones(2, 3, 4);
  %!numbl:opaque a b
  disp(a + b);
  disp(b + b);
  disp(b - a);
  disp(b .* b);
end

function test_nd_arith_ts()
  a = zeros(2, 3, 4);
  %!numbl:opaque a
  disp(a + 5);
  disp(a - 1);
  disp(a .* 7);
end

function test_nd_arith_st()
  a = zeros(2, 3, 4);
  %!numbl:opaque a
  disp(5 - a);
  disp(-a);
  disp(2 + a);
end

function test_nd_pass_to_func()
  a = zeros(2, 3, 4);
  %!numbl:opaque a
  disp(plus_one(a));
end

function test_nd_struct_field()
  s = struct('a', zeros(2, 3, 4));
  %!numbl:opaque s
  disp(s.a + 1);
end

function test_nd_class_field()
  b = Bag3();
  %!numbl:opaque b
  disp(b.payload + 1);
end

function test_zeros_n_square()
  disp(zeros(3));
  disp(ones(2));
end

function test_zeros_after_opaque()
  a = zeros(2, 3, 4);
  %!numbl:opaque a
  disp(a);
end

function y = plus_one(t)
  y = t + 1;
end

classdef Bag3
  properties
    % Default starts as the empty 0×0 tensor. The constructor
    % overwrites the slot with a 3-D shape; the C field stays
    % `mtoc2_tensor_t` regardless.
    payload = []
  end
  methods
    function obj = Bag3()
      obj.payload = zeros(2, 3, 4);
    end
  end
end
