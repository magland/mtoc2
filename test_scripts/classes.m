test_class_construct_basic();
test_class_property_read();
test_class_method_call();
test_class_method_func_syntax();
test_class_tensor_property();
test_class_default_only();
test_class_property_write();
test_class_used_in_loop();
test_class_property_no_default_scalar();
test_class_property_no_default_tensor();
test_class_property_no_default_mixed();
test_member_rooted_index();
test_member_rooted_index_write();
test_member_rooted_slice_write();
test_class_alias_isolation();
test_class_attr_passthrough();
test_dependent_property_getter();
test_dependent_property_setter();
test_dependent_property_multiple();
test_dependent_getter_calling_method();
test_dependent_property_read_only();
test_dependent_property_indexed_read();
test_dependent_property_indexed_slice();

function test_class_construct_basic()
  p = Point(3, 4);
  disp(p.x);
  disp(p.y);
end

function test_class_property_read()
  p = Point(2, 5);
  disp(p.x + p.y);
end

function test_class_method_call()
  p = Point(3, 4);
  disp(p.sumSq());
end

function test_class_method_func_syntax()
  % `method(obj, args)` form is not supported in mtoc2 v1.
  % Use only `obj.method(args)` to keep cross-runner output identical.
  p = Point(5, 12);
  disp(p.sumSq());
end

function test_class_tensor_property()
  b = Bag([1 2 3 4 5]);
  disp(b.total());
end

function test_class_default_only()
  d = Defaults();
  disp(d.a);
  disp(d.b);
end

function test_class_property_write()
  p = Point(1, 2);
  p.x = 100;
  disp(p.x);
  disp(p.y);
end

function test_class_used_in_loop()
  total = 0;
  for k = 1:5
    p = Point(k, k + 1);
    total = total + p.sumSq();
  end
  disp(total);
end

function test_class_property_no_default_scalar()
  % NoDefScalar declares its scalar properties without defaults;
  % the lowerer infers their types from the constructor body's
  % first writes (which read the constructor params).
  p = NoDefScalar(11, 7);
  disp(p.a);
  disp(p.b);
  disp(p.a + p.b);
end

function test_class_property_no_default_tensor()
  % Tensor-shaped properties without defaults — inference picks up
  % the C-level type `mtoc2_tensor_t` from the first write's RHS.
  b = NoDefTensor([2 4 6 8]);
  disp(sum(b.data));
end

function test_class_property_no_default_mixed()
  % Mixed: one property with a default, the other inferred.
  m = MixedDef(100);
  disp(m.fixed);   % default = 1
  disp(m.dynamic); % inferred to scalar double from `obj.dynamic = x;`
end

function test_member_rooted_index()
  % `obj.field(args)` lowers via a synthesized hoist: the property
  % load lands in a fresh temp and the index args run through the
  % normal IndexLoad / IndexSlice path against that temp. Covers
  % scalar reads, slice reads, and the `end` keyword against a
  % field-rooted base.
  b = Bag([10 20 30 40 50]);
  %!numbl:opaque b
  disp(b.data(1));         % scalar read
  disp(b.data(end));       % end against the loaded tensor
  disp(b.data(2:4));       % range slice
  disp(b.data(:));         % colon → column vector
end

function test_member_rooted_index_write()
  % Scalar slot write into a class property's tensor.
  b = Bag([10 20 30 40 50]);
  b.data(1) = 99;
  b.data(end) = 77;
  disp(b.data);
end

function test_member_rooted_slice_write()
  % Colon / range slice write into a class property's tensor.
  b = Bag([10 20 30 40 50]);
  b.data(2:4) = [-1, -2, -3];
  disp(b.data);
  b.data(:) = 0;
  disp(b.data);
end

function test_class_alias_isolation()
  % Same pass-by-value rule for class instances: `c = b` must not
  % share storage, so a write through one alias doesn't leak.
  a = Bag([1 2 3 4 5]);
  b = a;
  b.data(1) = 99;
  disp(a.data);
  disp(b.data);
end

function test_dependent_property_getter()
  % Read of a Dependent property routes through the `get.<prop>`
  % accessor. The getter reads the backing storage field.
  d = Doubler(7);
  disp(d.raw);
  disp(d.doubled);
end

function test_dependent_property_setter()
  % Write to a Dependent property with a setter routes through
  % `set.<prop>`. The setter mutates the backing storage; subsequent
  % reads of the dependent property observe the new value.
  d = Doubler(7);
  d.doubled = 100;
  disp(d.raw);
  disp(d.doubled);
end

function test_dependent_property_multiple()
  % A class can declare multiple Dependent properties in one block
  % (and across blocks). Each one routes through its own accessor.
  b = BoxStats(3, 4, 5);
  disp(b.volume);
  disp(b.surface);
  disp(b.diag2);
end

function test_dependent_getter_calling_method()
  % A getter body can call another instance method on the receiver.
  % The interpreter and AOT backends both dispatch the inner call.
  s = SumDep(2, 3);
  disp(s.total);
end

function test_dependent_property_indexed_read()
  % `obj.depProp(i, j)` calls the getter first, then indexes the
  % resulting tensor. The result is a freshly-owned value;
  % subsequent indexing happens on it.
  m = Mat3(2, 4);
  disp(m.transposed(1, 1));
  disp(m.transposed(2, 1));
  disp(m.transposed(3, 2));
end

function test_dependent_property_indexed_slice()
  % Same routing for slice indices (range / colon args). The
  % getter's tensor result is sliced by the standard tensor-slice
  % path.
  m = Mat3(2, 4);
  disp(m.transposed(:, 1));
  disp(m.transposed(2, :));
  disp(m.transposed(2:3, 1:2));
end

function test_dependent_property_read_only()
  % A Dependent property without a `set.<prop>` is read-only — the
  % only operation the program does on it is a read. Verifies that
  % getter routing works on a class that also has storage-backed
  % writable properties.
  r = ReadOnlyDep(9);
  disp(r.square);
  r.raw = 11;
  disp(r.square);
end

function test_class_attr_passthrough()
  % `properties` blocks with Access / GetAccess / SetAccess / Hidden
  % attributes parse and behave as if the attribute weren't there —
  % mtoc2 doesn't enforce visibility (matches numbl). Reads and
  % writes work the same way as plain storage properties.
  v = Vault(7, 11, 13);
  disp(v.pub);
  disp(v.priv);
  disp(v.hid);
  disp(v.setpriv);
  v.pub = 100;
  v.priv = 200;
  v.hid = 300;
  v.setpriv = 400;
  disp(v.pub);
  disp(v.priv);
  disp(v.hid);
  disp(v.setpriv);
end

classdef Point
  properties
    x = 0
    y = 0
  end
  methods
    function obj = Point(x, y)
      obj.x = x;
      obj.y = y;
    end
    function r = sumSq(obj)
      r = obj.x * obj.x + obj.y * obj.y;
    end
  end
end

classdef Bag
  properties
    % Default is the empty 0×0 tensor. The C typedef hash sees only
    % the C-level type (`mtoc2_tensor_t`), so the constructor can
    % overwrite `obj.data` with a tensor of any shape — the slot
    % stays an `mtoc2_tensor_t`. Reads of `obj.data` carry the
    % field's current internal type (refined by the latest write).
    data = []
  end
  methods
    function obj = Bag(d)
      obj.data = d;
    end
    function s = total(obj)
      s = sum(obj.data);
    end
  end
end

classdef Defaults
  properties
    a = 7
    b = -3
  end
  methods
  end
end

classdef NoDefScalar
  properties
    a  % no default — type inferred from constructor's first write
    b  % no default — type inferred from constructor's first write
  end
  methods
    function obj = NoDefScalar(x, y)
      obj.a = x;
      obj.b = y;
    end
  end
end

classdef NoDefTensor
  properties
    data  % no default; constructor writes a tensor → C-level type is mtoc2_tensor_t
  end
  methods
    function obj = NoDefTensor(d)
      obj.data = d;
    end
  end
end

classdef MixedDef
  properties
    fixed = 1   % explicit default → eagerly typed at registration
    dynamic     % no default — inferred from constructor write
  end
  methods
    function obj = MixedDef(x)
      obj.dynamic = x;
    end
  end
end

classdef Vault
  % Each properties block carries an attribute that mtoc2 must accept
  % silently (matching numbl). Storage and dispatch are unchanged.
  properties (Access = public)
    pub = 0
  end
  properties (Access = private)
    priv = 0
  end
  properties (Hidden, Access = public)
    hid = 0
  end
  properties (SetAccess = private)
    setpriv = 0
  end
  methods
    function obj = Vault(a, b, c)
      obj.pub = a;
      obj.priv = b;
      obj.hid = c;
      obj.setpriv = a + b + c;
    end
  end
end

classdef Doubler
  % Single Dependent property `doubled` backed by `raw`. The setter
  % maintains the invariant `doubled == 2*raw` by writing `raw`.
  properties (Hidden)
    raw
  end
  properties (Dependent)
    doubled
  end
  methods
    function obj = Doubler(x)
      obj.raw = x;
    end
    function y = get.doubled(obj)
      y = obj.raw * 2;
    end
    function obj = set.doubled(obj, val)
      obj.raw = val / 2;
    end
  end
end

classdef BoxStats
  % Multiple Dependent properties in one block, plus another block.
  % Getters each read different combinations of the backing fields.
  properties
    w
    h
    d
  end
  properties (Dependent)
    volume
    surface
  end
  properties (Dependent, Access = public)
    diag2
  end
  methods
    function obj = BoxStats(w, h, d)
      obj.w = w;
      obj.h = h;
      obj.d = d;
    end
    function v = get.volume(obj)
      v = obj.w * obj.h * obj.d;
    end
    function s = get.surface(obj)
      s = 2 * (obj.w*obj.h + obj.w*obj.d + obj.h*obj.d);
    end
    function s = get.diag2(obj)
      s = obj.w*obj.w + obj.h*obj.h + obj.d*obj.d;
    end
  end
end

classdef SumDep
  % A getter that calls another instance method on `obj`.
  properties
    a
    b
  end
  properties (Dependent)
    total
  end
  methods
    function obj = SumDep(a, b)
      obj.a = a;
      obj.b = b;
    end
    function s = computeSum(obj)
      s = obj.a + obj.b;
    end
    function s = get.total(obj)
      s = obj.computeSum();
    end
  end
end

classdef Mat3
  % Backing storage is a 2-D matrix; the Dependent `transposed`
  % returns its transpose. Used to exercise indexed reads through
  % the getter (phase C of the property-attributes plan).
  properties
    data
  end
  properties (Dependent)
    transposed
  end
  methods
    function obj = Mat3(r, c)
      obj.data = reshape(1:(r*c), r, c);
    end
    function t = get.transposed(obj)
      t = obj.data';
    end
  end
end

classdef ReadOnlyDep
  % A Dependent property without a setter. Reads route through the
  % getter; writes to it would error (not exercised here — the test
  % only writes to the underlying storage field).
  properties
    raw
  end
  properties (Dependent, SetAccess = private)
    square
  end
  methods
    function obj = ReadOnlyDep(x)
      obj.raw = x;
    end
    function y = get.square(obj)
      y = obj.raw * obj.raw;
    end
  end
end
