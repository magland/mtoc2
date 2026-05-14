test_pow_scalar_pos_int_exp();
test_pow_scalar_pos_float_exp();
test_pow_neg_base_int_exp();
test_pow_zero_exp();
test_pow_zero_base_pos_exp();
test_pow_tensor_scalar();
test_pow_scalar_tensor();
test_pow_tensor_tensor();
test_pow_caret_scalar();
test_pow_chain();
test_pow_after_opaque();
test_pow_in_expression();
test_pow_unary_neg();

function test_pow_scalar_pos_int_exp()
  disp(2 .^ 3);
  disp(2 .^ 4);
  disp(3 .^ 2);
  disp(10 .^ 3);
end

function test_pow_scalar_pos_float_exp()
  disp(4 .^ 0.5);
  disp(9 .^ 0.5);
  disp(8 .^ (1/3));
end

function test_pow_neg_base_int_exp()
  % Negative base with integer exponent is real — allowed.
  disp((-2) .^ 3);
  disp((-2) .^ 4);
  disp((-1) .^ 5);
end

function test_pow_zero_exp()
  disp(5 .^ 0);
  disp((-3) .^ 0);
  disp(0 .^ 0);   % MATLAB: 0^0 = 1
end

function test_pow_zero_base_pos_exp()
  disp(0 .^ 2);
  disp(0 .^ 5);
end

function test_pow_tensor_scalar()
  disp([1 2 3] .^ 2);
  disp([1 2 3 4] .^ 3);
  disp([0.5 1 2] .^ 2);
  disp([1 2; 3 4] .^ 2);
end

function test_pow_scalar_tensor()
  disp(2 .^ [1 2 3]);
  disp(10 .^ [0 1 2 3]);
end

function test_pow_tensor_tensor()
  disp([2 3] .^ [3 2]);
  disp([1 2 3] .^ [2 2 2]);
end

function test_pow_caret_scalar()
  disp(2 ^ 3);
  disp(3 ^ 2);
  disp(2 ^ 0.5);
end

function test_pow_chain()
  disp(2 .^ (1 + 1));
  disp((2 .^ 3) .^ 2);
  disp(2 .^ (2 .^ 2));
end

function test_pow_after_opaque()
  a = 3;
  %!numbl:opaque a
  disp(a .^ 2);
  disp(2 .^ a);

  v = [1 2 3 4];
  %!numbl:opaque v
  disp(v .^ 2);
  disp(2 .^ v);
end

function test_pow_in_expression()
  x = 4;
  %!numbl:opaque x
  disp(sqrt(x .^ 2));
  disp(1 + 2 .^ x);
end

function test_pow_unary_neg()
  % -2 ^ 3 in MATLAB is -(2^3) = -8 (unary minus has lower precedence than ^).
  % Confirm we agree with numbl.
  disp(-2 ^ 3);
  disp(-(2 ^ 3));
  disp((-2) ^ 3);
end
