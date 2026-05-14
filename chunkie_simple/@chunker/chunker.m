classdef chunker
%CHUNKER simplified value class for a discretized 2D curve.
%
% Compared to the full @chunker in chunkie, this version drops:
%   - preferences/storage indirection (nchmax/nchstor/rstor/dstor/...)
%   - vertex tracking, data rows
%   - Dependent / Hidden / SetAccess decoration
% Storage is direct: r/d/d2/n are dim x k x nch tensors,
% adj is 2 x nch, wts is k x nch. The constructor takes no arguments;
% chunkerfunc fills the fields in.

    properties
        k = 16
        nch = 0
        dim = 2
        r = []
        d = []
        d2 = []
        n = []
        adj = []
        wts = []
    end

    methods
        function obj = chunker()
            % empty constructor; chunkerfunc populates the fields.
        end
    end
end
