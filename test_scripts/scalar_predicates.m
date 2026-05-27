test_isfield_struct();
test_isfield_string_name();
test_isfield_non_struct();
test_isfield_class_instance();
test_isfield_if_pattern();
test_isscalar_numeric();
test_isscalar_complex();
test_isscalar_text();
test_isscalar_struct_class_handle();
test_isequal_scalar();
test_isequal_tensor();
test_isequal_scalar_tensor();
test_isequal_complex();
test_isequal_nargs();
test_isreal_basic();
test_isempty_basic();
test_ndims_ismatrix();
test_rowcol();
test_char_string_int();
test_isstruct_basic();
test_isa_basic();
test_or_and_functional();

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

function test_isequal_scalar()
  disp(isequal(5, 5));
  disp(isequal(5, 6));
  % runtime (non-exact) operands
  x = numel([1 2 3 4]);
  disp(isequal(x, 4));
end

function test_isequal_tensor()
  a = [1 2 3] + 0;   % force a runtime tensor
  disp(isequal(a, [1 2 3]));
  disp(isequal(a, [1 2 4]));
  disp(isequal(a, [1 2]));
  disp(isequal([1 2; 3 4], [1 2 3 4]));   % shape mismatch
  disp(isequal(size([1 2 3]), [1 3]));
end

function test_isequal_scalar_tensor()
  v = [7] + 0;
  disp(isequal(7, v));      % scalar vs 1x1 tensor
  disp(isequal([1 2 3], 1)); % tensor vs scalar (numel > 1)
end

function test_isequal_complex()
  z = (2 + 3i) + 0;
  disp(isequal(z, 2 + 3i));
  disp(isequal(z, 2 + 4i));
  disp(isequal(2 + 0i, 2));  % complex with zero imag equals real
end

function test_isequal_nargs()
  disp(isequal(3, 3, 3));
  disp(isequal(3, 3, 4));
end

function test_isreal_basic()
  disp(isreal(5));
  disp(isreal([1 2 3]));
  disp(isreal(3i));            % complex scalar literal
  z = (2 + 3i) + 0;           % runtime complex scalar
  disp(isreal(z));
  disp(isreal(2 + 0i));        % zero imaginary → real
  w = [1+2i, 3-1i] + 0;       % runtime complex tensor
  disp(isreal(w));
end

function test_isempty_basic()
  disp(isempty([]));
  disp(isempty([1 2 3]));
  disp(isempty(5));
  disp(isempty(zeros(0, 3)));  % statically-empty shape
  n = numel([1 2 3 4]);        % keep a runtime scalar around
  disp(isempty(zeros(1, n)));  % runtime-shaped, non-empty
end

function test_ndims_ismatrix()
  disp(ndims(5));
  disp(ndims([1 2 3]));
  disp(ndims([1 2; 3 4]));
  disp(ndims(zeros(2, 3, 4)));
  disp(ismatrix(5));
  disp(ismatrix([1 2; 3 4]));
  disp(ismatrix(zeros(2, 3, 4)));
end

function test_rowcol()
  disp(isrow(5));
  disp(isrow([1 2 3]));
  disp(isrow([1; 2; 3]));
  disp(iscolumn([1; 2; 3]));
  disp(iscolumn([1 2 3]));
  % runtime-shaped row (dim 0 statically 1)
  n = numel([1 2 3 4 5]);
  disp(isrow(zeros(1, n)));
  disp(iscolumn(zeros(n, 1)));
end

function test_char_string_int()
  disp(ischar('hello'));
  disp(ischar(5));
  disp(isstring("hi"));
  disp(isstring('hi'));
  disp(isinteger(5));
  disp(isinteger(3.5));
end

function test_isstruct_basic()
  s = struct('a', 1, 'b', 2);
  disp(isstruct(s));
  disp(isstruct(5));
  disp(isstruct('hi'));
  disp(isstruct([1 2 3]));
  % Class instances are NOT structs (matches MATLAB / numbl).
  p = PredPoint(3, 4);
  disp(isstruct(p));
end

function test_isa_basic()
  disp(isa(5, 'double'));
  disp(isa(true, 'logical'));
  disp(isa('hi', 'char'));
  disp(isa("hi", 'string'));
  disp(isa(struct('a', 1), 'struct'));
  disp(isa(5, 'numeric'));
  disp(isa(true, 'numeric'));  % logical is NOT numeric
  % Class instance: name match wins.
  p = PredPoint(1, 2);
  disp(isa(p, 'PredPoint'));
  disp(isa(p, 'double'));
end

function test_or_and_functional()
  % Functional `or(a, b)` / `and(a, b)` mirror the corresponding
  % short-circuit operators for scalar args (the runtime difference
  % between `|` and `||` is moot once both args have been evaluated
  % by the call site).
  disp(or(true, false));
  disp(or(false, false));
  disp(and(true, true));
  disp(and(true, false));
  % Mixed-shape pattern from chunkerpref: `or(isstruct(x), isa(x, 'C'))`.
  s = struct('a', 1);
  disp(or(isstruct(s), isa(s, 'PredPoint')));
end

classdef PredPoint
  properties
    x = 0
    y = 0
  end
  methods
    function obj = PredPoint(x, y)
      obj.x = x;
      obj.y = y;
    end
  end
end
