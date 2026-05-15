function fkern = kernel(name, type, zk, coefs)
%KERNEL  Simplified chunkie-style kernel constructor.
%
% Returns a function handle that evaluates the requested boundary-
% integral kernel. Only the Helmholtz combined-layer ('helm', 'c')
% case is implemented; `name` and `type` are accepted for API
% compatibility but not validated.
%
% Usage matching the chunkie example:
%   fkern = kernel('helm', 'c', zk, [1, -zk*1i]);
%   sysmat = chunkermat(chnkr, fkern);

fkern = @(src, src_n, targ) helm2d_combined(zk, coefs, src, src_n, targ);

end
