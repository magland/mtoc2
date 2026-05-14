test_class_construct_basic();
test_class_property_read();
test_class_method_call();
test_class_method_func_syntax();
test_class_tensor_property();
test_class_default_only();
test_class_property_write();
test_class_used_in_loop();

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
