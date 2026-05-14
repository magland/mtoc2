test_nargout_inside_function();
test_nargout_specialization_per_caller();
test_nargin_inside_function();
test_nargout_in_branch();
test_nargout_multi_assign();

function test_nargout_inside_function()
  % Expression-context call: nargout = 1.
  disp(report_nargout(7));
end

function test_nargout_specialization_per_caller()
  % `pair` is specialized twice: once at the bare-call site (nargout=0,
  % drop-all), once at the multi-assign site (nargout=2). The
  % `if nargout >= 2` branch fires at the multi-assign site only.
  [u, v] = pair(7);
  disp(u);
  disp(v);

  % bare drop-all — both outputs computed but discarded.
  pair(9);
  disp(100);
end

function test_nargin_inside_function()
  disp(report_nargin(5));
  disp(report_nargin_pair(5, 11));
end

function test_nargout_in_branch()
  % The if-cond folds at compile time because `nargout` is a constant
  % per specialization. The other branch's body never reaches codegen.
  disp(maybe_double(3));
  [a, b] = maybe_double_pair(3);
  disp(a);
  disp(b);
end

function test_nargout_multi_assign()
  % Three-output function called with 2 vs 3 lvalues. The
  % specialization-by-nargout means each call site gets a distinct
  % spec; the `if nargout >= 3` branch fires at the 3-lvalue site
  % only.
  [a, b] = triple_or_less(4);
  disp(a);
  disp(b);
  [a2, b2, c] = triple_or_less(4);
  disp(a2);
  disp(b2);
  disp(c);
end

function y = report_nargout(x)
  y = x + nargout;       % nargout is 1 in expression context
end

function [a, b] = pair(x)
  a = x;
  if nargout >= 2
    b = x * 10;
  else
    b = 0;
  end
end

function y = report_nargin(x)
  y = nargin;
end

function y = report_nargin_pair(x, z)
  y = nargin + x + z;
end

function y = maybe_double(x)
  if nargout >= 1
    y = x * 2;
  else
    y = x;
  end
end

function [a, b] = maybe_double_pair(x)
  if nargout >= 2
    a = x * 2;
    b = x * 3;
  else
    a = x;
    b = 0;
  end
end

function [a, b, c] = triple_or_less(x)
  a = x + 1;
  if nargout >= 2
    b = x + 2;
  else
    b = 0;
  end
  if nargout >= 3
    c = x + 3;
  else
    c = 0;
  end
end
