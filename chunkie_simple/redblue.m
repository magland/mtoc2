function c = redblue(m)
%REDBLUE  Blue-white-red diverging colormap, m x 3 RGB rows.
%
% Simplified from chunkie/redblue.m: fixed-arity (m is required),
% handles both even and odd m via linspace + column construction.

if mod(m, 2) == 0
    m1 = m * 0.5;
    % Bottom half: blue to white. Top half: white to red.
    r_bot = linspace(0, 1 - 1/m1, m1).';
    r_top = ones(m1, 1);
    r = [r_bot; r_top];
    g = [r_bot; flipud(r_bot)];
    b = flipud(r);
else
    m1 = floor(m * 0.5);
    r_bot = linspace(0, 1 - 1/(m1 + 1), m1).';
    r_top = ones(m1 + 1, 1);
    r = [r_bot; r_top];
    g = [r_bot; 1; flipud(r_bot)];
    b = flipud(r);
end

c = [r, g, b];

end
