% External method declarations: a classdef may list method
% signatures (prototype rows with no `function` keyword) inside a
% `methods` / `methods(Static)` block. The actual body lives in an
% `@<Cls>/<name>.m` file. Signatures in a `methods(Static)` block
% mark the corresponding external file as static; instance
% signatures are informational only (we already collect external
% method files as instance methods by default).
test_instance_signature();
test_static_signature();
test_multioutput_method_single_output_call();

function test_instance_signature()
  s = Sig(7);
  disp(s.scaled(3));
end

function test_static_signature()
  disp(Sig.zero());
end

function test_multioutput_method_single_output_call()
  s = Sig(10);
  % `mins` declares 3 outputs but caller wants just one (single-
  % output dispatch on a multi-output method). The body's first
  % return value is what we observe.
  x = s.mins(2, 5, 4);
  disp(x);
end
