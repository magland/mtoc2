classdef Sig
  properties
    base = 0
  end
  methods
    function obj = Sig(b)
      obj.base = b;
    end
    % Prototype-only declarations. The implementations live in
    % external `.m` files in this folder.
    y = scaled(obj, k)
    [a, b, c] = mins(obj, x, y, z)
  end
  methods(Static)
    % Static signature: routes the @Sig/zero.m file to
    % `staticMethods` instead of `methods`.
    v = zero()
  end
end
