% mtoc2 emits user variable / param names verbatim into C, but a
% number of legal MATLAB identifiers (`struct`, `union`, `typedef`,
% `auto`, `extern`, `for`-as-var-name-via-loop, ...) are reserved C
% keywords. Without mangling, the emitted C fails to compile.
% The fix maps every user-source variable / param / for-loop var
% through `cIdentForUserName` at declaration time, prefixing
% reserved names with `v_`.

test_struct_as_variable();
test_typedef_as_param();
test_union_in_for_loop();

function test_struct_as_variable()
  % `struct` shadows the builtin and indexes a row vector — exercises
  % both the env-priority fix (`struct(...)` shouldn't dispatch to
  % the constructor when shadowed) and the C-keyword mangle.
  struct = [10 20 30];
  disp(struct(2));
end

function test_typedef_as_param()
  % Param name is a C keyword. The function signature, body reads,
  % and call site all need the mangled name.
  disp(double_it(7));
end

function r = double_it(typedef)
  r = typedef * 2;
end

function test_union_in_for_loop()
  total = 0;
  for static = 1:3
    total = total + static;
  end
  disp(total);
end
