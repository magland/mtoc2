function [ts, whts] = rts_stab(n)
%LEGE.RTS_STAB Legendre nodes and weights via Newton's method on
% an initial Chebyshev guess. O(n^2), numerically stable.
%
% Adapted from chunkie/+lege/rts_stab.m
% Copyright (C) 2009: Vladimir Rokhlin (FreeBSD license)

nnewt   = 10;
nstop   = 3;
stoptol = 1e-12;

ifodd = mod(n, 2);
h = pi / (2*n);

% work on the right half of [-1,1], starting from Chebyshev nodes
rstart = (n - ifodd) / 2 + 1;
tsr = -cos((2 * (rstart:n) - 1) * h);
tsr = tsr(:);

for kk = 1:length(tsr)
    x1 = tsr(kk);
    ifstop = 0;
    for i = 1:nnewt
        [p, dp] = lege.pol(x1, n);
        x1 = x1 - p / dp;
        if abs(p) < stoptol; ifstop = ifstop + 1; end
        if ifstop >= nstop; break; end
    end
    tsr(kk) = x1;
end

ts = zeros(n, 1);
ts(rstart:n) = tsr(:);
ts(1:(rstart + ifodd - 1)) = -flipud(tsr);

if nargout > 1
    [~, ~, totr] = lege.polsum(tsr, n);
    whts = zeros(n, 1);
    whts(rstart:n) = 1 ./ totr(:);
    whts(1:(rstart + ifodd - 1)) = flipud(1 ./ totr(:));
end

end
