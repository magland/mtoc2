function deal_basics()
  test_three_out_three_in();
  test_two_out_two_in();
  test_one_in_broadcast_three_out();
  test_one_in_broadcast_two_out();
  test_one_out_one_in();
  test_mixed_scalar_and_tensor();
  test_tensor_passthrough();
  test_char_passthrough();
  test_independent_writes_after_deal();
  test_deal_with_opaque();
  disp('SUCCESS');
end

function test_three_out_three_in()
  [a, b, c] = deal(1, 2, 3);
  disp(a);
  disp(b);
  disp(c);
end

function test_two_out_two_in()
  [x, y] = deal(10, 20);
  disp(x);
  disp(y);
end

function test_one_in_broadcast_three_out()
  [a, b, c] = deal(7);
  disp(a);
  disp(b);
  disp(c);
end

function test_one_in_broadcast_two_out()
  [u, v] = deal(99);
  disp(u);
  disp(v);
end

function test_one_out_one_in()
  a = deal(42);
  disp(a);
end

function test_mixed_scalar_and_tensor()
  [k, v] = deal(5, [10 20 30]);
  disp(k);
  disp(v);
end

function test_tensor_passthrough()
  [a, b] = deal([1 2 3], [4 5 6 7]);
  disp(a);
  disp(b);
end

function test_char_passthrough()
  [s1, s2] = deal('hello', 'world');
  disp(s1);
  disp(s2);
end

function test_independent_writes_after_deal()
  % After broadcast, mutating one output must not bleed into the others.
  [a, b, c] = deal([1 2 3]);
  a(1) = 100;
  b(2) = 200;
  disp(a);
  disp(b);
  disp(c);
end

function test_deal_with_opaque()
  x = 5;
  y = 10;
  %!numbl:opaque x y
  [a, b] = deal(x, y);
  disp(a);
  disp(b);
end
