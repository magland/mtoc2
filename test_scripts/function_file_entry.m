% Function-file auto-invoke: a driver whose body is only function
% definitions (no top-level statements) runs by calling its FIRST
% function with zero args. Mirrors numbl's Interpreter.run. The entry
% function below calls the sibling locals, so this also checks that
% the synthesized entry call resolves local functions normally.

function function_file_entry()
  disp(add_one(41));
  disp(double_it(21));
  greet();
  disp('SUCCESS');
end

function y = add_one(x)
  y = x + 1;
end

function y = double_it(x)
  y = x * 2;
end

function greet()
  fprintf('hello from a function file\n');
end
