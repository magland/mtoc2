function r = starfish(t, narms, amp)
%STARFISH parametric starfish curve (simplified).
%
% Original chunkie/starfish.m signature was [r, d, d2] = starfish(t, varargin)
% with optional narms / amp / ctr / phi / scale. mtoc2 is fixed-arity and
% the simplified chunkerfunc uses spectral differentiation to derive
% d / d2 from r, so this version takes (t, narms, amp) and returns only r.
%
% Parameterization:
%   x(t) = (1 + amp*cos(narms*t)) * cos(t)
%   y(t) = (1 + amp*cos(narms*t)) * sin(t)

ct  = cos(t);
st  = sin(t);
cnt = cos(narms * t);

xs = (1 + amp * cnt) .* ct;
ys = (1 + amp * cnt) .* st;

r = [xs(:).'; ys(:).'];

end
