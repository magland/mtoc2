% Pass char / string into user functions (different ABI shapes).

test_char_param();
test_string_param();
test_reassign_in_branch();
test_text_var_to_var_copy();

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
