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
test_strcmp_basic();
test_strcmpi_case_fold();
test_strcmp_mixed_kinds();
test_strcmp_non_text();
test_strcmp_var_args();
test_strcmp_in_if();

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

function test_strcmp_basic()
  disp(strcmp('abc', 'abc'));
  disp(strcmp('abc', 'abd'));
  disp(strcmp('abc', 'abcd'));
  disp(strcmp('', ''));
  disp(strcmp('', 'x'));
  disp(strcmp("hello", "hello"));
  disp(strcmp("hello", "world"));
end

function test_strcmpi_case_fold()
  disp(strcmpi('abc', 'ABC'));
  disp(strcmpi('Hello', 'hello'));
  disp(strcmpi('abc', 'aBd'));
  disp(strcmpi("MIXED", "mixed"));
  disp(strcmpi("MIXED", "mixed!"));
end

function test_strcmp_mixed_kinds()
  % Char vs String: numbl compares the raw bytes either way.
  disp(strcmp('hi', "hi"));
  disp(strcmp("hi", 'hi'));
  disp(strcmpi('Hi', "hi"));
end

function test_strcmp_non_text()
  % Numbl: non-text first or second arg silently yields 0.
  disp(strcmp(5, 'abc'));
  disp(strcmp('abc', 5));
  disp(strcmp(5, 5));
end

function test_strcmp_var_args()
  % Non-literal args force the runtime helper path.
  a = 'descend';
  b = 'descend';
  c = 'ascend';
  disp(strcmp(a, b));
  disp(strcmp(a, c));
  disp(strcmpi('DESCEND', a));
end

function test_strcmp_in_if()
  mode = 'descend';
  if strcmp(mode, 'descend')
    disp(100);
  end
  if ~strcmp(mode, 'ascend')
    disp(200);
  end
end
