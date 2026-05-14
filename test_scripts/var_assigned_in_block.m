% Variables first assigned inside a nested If / While / For body must
% stay in scope after the merge. MATLAB / numbl treat them as declared
% along whichever branch ran; mtoc2 hoists their C-level declarations
% to function top so reads after the block see the last write. The
% For-loop variable itself is also preserved (its final iteration
% value is readable after the loop).

test_var_assigned_in_for();
test_loop_var_after_for();
test_var_assigned_in_if();
test_var_assigned_in_while();
test_var_assigned_in_elseif_chain();

function test_var_assigned_in_for()
  for k = 1:5
    a = k;
  end
  disp(a);
end

function test_loop_var_after_for()
  for k = 1:3
  end
  disp(k);
end

function test_var_assigned_in_if()
  x = 1;
  %!numbl:opaque x
  if x
    b = 7;
  end
  disp(b);
end

function test_var_assigned_in_while()
  i = 0;
  while i < 3
    i = i + 1;
    last = i * 10;
  end
  disp(last);
end

function test_var_assigned_in_elseif_chain()
  x = 2;
  %!numbl:opaque x
  if x == 1
    r = 100;
  elseif x == 2
    r = 200;
  else
    r = 300;
  end
  disp(r);
end
