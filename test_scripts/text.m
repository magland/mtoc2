% Char and string literals: disp, assign / reassign, params, branches,
% loop reassignment, and var-to-var copies.

test_char_basic();
test_string_basic();
test_loop_char();
test_loop_string();
test_char_param();
test_string_param();
test_reassign_in_branch();
test_text_var_to_var_copy();

function test_char_basic()
  disp('hello');
  disp('a');
  disp('');

  s = 'world';
  disp(s);

  s = 'second';
  disp(s);

  c = 'x';
  disp(c);

  % Embedded escape: backslash + n is two chars in MATLAB char literals.
  disp('a\nb');
end

function test_string_basic()
  disp("hello");
  disp("a");
  disp("");

  s = "world";
  disp(s);

  s = "second";
  disp(s);

  c = "x";
  disp(c);
end

function test_loop_char()
  % Reassign a char inside a for-loop. The forward `nullAtScopeExit`
  % dataflow must NOT skip the scope-exit free (some iteration leaves
  % the buffer allocated), and the body-reassign path must free the
  % prior buffer before each new assignment.
  for i = 1:3
    s = 'iter';
    disp(s);
  end
  disp('done');
end

function test_loop_string()
  for i = 1:3
    s = "iter";
    disp(s);
  end
  disp("done");
end

function test_char_param()
  greet_char('hello');
  greet_char('a');
end

function test_string_param()
  greet_string("world");
  greet_string("xy");
end

function test_reassign_in_branch()
  % Force runtime evaluation of which branch we hit so the env-merge
  % is exercised.
  flag = 1;
  if flag > 0
    s = 'left';
  else
    s = 'right';
  end
  disp(s);
end

function test_text_var_to_var_copy()
  a = 'source';
  b = a;
  disp(b);
  disp(a);   % a must still be live
end

function greet_char(s)
  disp(s);
end

function greet_string(s)
  disp(s);
end
