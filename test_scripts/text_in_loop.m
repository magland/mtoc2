% Reassign a char/string variable inside a for-loop. The forward
% `nullAtScopeExit` dataflow must NOT skip the scope-exit free
% (some iteration leaves the buffer allocated), and the body-reassign
% path must free the prior buffer before each new assignment.

test_loop_char();
test_loop_string();

function test_loop_char()
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
