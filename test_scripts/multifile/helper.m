function y = helper(x)
  y = x * x + sub(x);
end

% Subfunction — visible only inside helper.m.
function s = sub(x)
  s = x + 1;
end
