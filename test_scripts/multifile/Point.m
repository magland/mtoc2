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
    function out = shifted(obj, dx)
      % Calls a sibling workspace function (`double_it`) from
      % inside a workspace-class method. Exercises cross-file
      % resolution originating from class-file scope.
      out = obj;
      out.x = obj.x + double_it(dx);
    end
  end
  methods (Static)
    function r = origin_sq()
      r = 0;
    end
  end
end
