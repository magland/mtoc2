classdef Counter
  properties
    value = 0
  end
  methods
    function obj = Counter(v)
      if nargin >= 1
        obj.value = v;
      end
    end
  end
end
