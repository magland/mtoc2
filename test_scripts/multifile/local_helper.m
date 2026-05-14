function y = local_helper(x)
  % Returns x*100 — but main.m has its own local function with the
  % same name, which the resolver picks first when called from
  % within main.m's body. This file is here to exercise the
  % shadowing rule.
  y = x * 100;
end
