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
