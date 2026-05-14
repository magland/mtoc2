% A statically-length-1 range like `1:1` (or `5:5:5`) is type-system
% scalar (both dims 1). The IR was `MakeRange` which always emits
% `mtoc2_tensor_make_range(...)` returning a tensor struct — assigning
% to a `double` LHS produced a C compile error. The fix collapses
% length-1 MakeRange to its start expression at lowering time, the
% same way a 1×1 bracket literal `[x]` does.

test_basic_length_one_range();
test_with_step();
test_in_arithmetic();
test_disp_directly();

function test_basic_length_one_range()
  x = 1:1;
  disp(x);
end

function test_with_step()
  x = 5:5:5;
  disp(x);
end

function test_in_arithmetic()
  x = (3:3) * 4;
  disp(x);
end

function test_disp_directly()
  disp(7:7);
end
