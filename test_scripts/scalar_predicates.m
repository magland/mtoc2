test_isfield_struct();
test_isfield_string_name();
test_isfield_non_struct();
test_isfield_class_instance();
test_isfield_if_pattern();
test_isscalar_numeric();
test_isscalar_complex();
test_isscalar_text();
test_isscalar_struct_class_handle();

function test_isfield_struct()
  s = struct('alpha', 1, 'beta', 2);
  disp(isfield(s, 'alpha'));
  disp(isfield(s, 'beta'));
  disp(isfield(s, 'gamma'));
end

function test_isfield_string_name()
  s = struct('alpha', 1);
  disp(isfield(s, "alpha"));
  disp(isfield(s, "gamma"));
end

function test_isfield_non_struct()
  % Numbl returns false for any non-struct/class first arg. The
  % `[]` case matters for chunkie's "absent-struct sentinel" idiom.
  disp(isfield([], 'foo'));
  disp(isfield(5, 'foo'));
  disp(isfield(zeros(3), 'foo'));
  disp(isfield('hi', 'foo'));
  disp(isfield("hi", 'foo'));
  h = @(x) x + 1;
  disp(isfield(h, 'foo'));
end

function test_isfield_class_instance()
  p = SPPoint(3, 4);
  disp(isfield(p, 'x'));
  disp(isfield(p, 'y'));
  disp(isfield(p, 'z'));
end

function test_isfield_if_pattern()
  % The chunkie idiom: default-init a struct field if absent. Folds
  % at if-cond time because the struct's field set is static.
  opts = struct('tol', 0.5);
  if isfield(opts, 'tol')
    disp(100 + opts.tol);
  end
  if ~isfield(opts, 'maxit')
    disp(42);
  end
  % Same pattern over an empty-matrix sentinel.
  cparams = [];
  if ~isfield(cparams, 'ta')
    disp(7);
  end
end

function test_isscalar_numeric()
  disp(isscalar(5));
  disp(isscalar(0));
  disp(isscalar(-3.5));
  disp(isscalar([]));
  disp(isscalar([1 2]));
  disp(isscalar([1; 2; 3]));
  disp(isscalar(zeros(1, 1)));
  disp(isscalar(zeros(2, 3)));
  disp(isscalar(1 < 2));
  disp(isscalar(0 == 0));
end

function test_isscalar_complex()
  disp(isscalar(1 + 2i));
  disp(isscalar([1+1i 2+2i]));
end

function test_isscalar_text()
  % Numbl treats `"..."` as a scalar handle; `'...'` is a 1×N char
  % array and is non-scalar even at length 1.
  disp(isscalar("hi"));
  disp(isscalar("a"));
  disp(isscalar('hi'));
  disp(isscalar('a'));
end

function test_isscalar_struct_class_handle()
  s = struct('a', 1);
  disp(isscalar(s));
  p = SPPoint(3, 4);
  disp(isscalar(p));
  h = @(x) x + 1;
  disp(isscalar(h));
end

classdef SPPoint
  properties
    x
    y
  end
  methods
    function obj = SPPoint(x, y)
      obj.x = x;
      obj.y = y;
    end
  end
end
