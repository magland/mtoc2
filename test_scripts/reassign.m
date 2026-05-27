% Type-changing reassignment. A variable reassigned to a value whose C
% storage is incompatible with its prior binding (char↔double,
% scalar↔tensor, real↔complex, ...) is SPLIT into a fresh C local at the
% top level of a scope — the prior binding stays valid for earlier reads.
% (Inside non-folded control flow this is rejected; see the comment in
% recordAssignment.) The interpreter just overwrites the value.

test_char_to_double();
test_walk_categories();
test_real_to_complex();
test_tensor_to_scalar();
test_split_then_continue();

function test_char_to_double()
  x = 'hello';
  disp(x);
  x = 5;
  disp(x);
end

function test_walk_categories()
  % char → double → char → tensor, all at function-top scope.
  x = 'abc';
  disp(x);
  x = 42;
  disp(x);
  x = 'world';
  disp(x);
  x = [1 2 3];
  disp(x);
end

function test_real_to_complex()
  z = 3;
  disp(z);
  z = 2 + 3i;
  disp(z);
end

function test_tensor_to_scalar()
  v = [1 2 3 4];
  disp(sum(v));
  v = 9;
  disp(v);
end

function test_split_then_continue()
  % After a split the new binding behaves like any other variable:
  % arithmetic and a further compatible reassignment reuse its C local.
  x = 'tag';
  disp(x);
  x = 10;
  x = x + 5;
  disp(x);
end
