test_cross_file_function();
test_cross_file_class_construct();
test_cross_file_instance_method();
test_cross_file_method_func_syntax();
test_cross_file_static_method();
test_main_local_helper_shadows_workspace();
test_workspace_func_calls_workspace_func();
test_workspace_method_calls_workspace_func();

function test_cross_file_function()
  % `helper` lives in helper.m and is callable by its bare basename.
  disp(helper(3));
  disp(helper(10));
end

function test_cross_file_class_construct()
  % `Point` lives in Point.m (classdef-file workspace class).
  p = Point(2, 5);
  disp(p.x);
  disp(p.y);
end

function test_cross_file_instance_method()
  % Method dispatch on a workspace class.
  p = Point(3, 4);
  disp(p.sumSq());
end

function test_cross_file_method_func_syntax()
  % `method(obj, args)` form: numbl's resolver sees a ClassInstance
  % in the arg list and routes to the class's instance method.
  p = Point(5, 12);
  disp(sumSq(p));
end

function test_cross_file_static_method()
  % Static method called by class name.
  disp(Point.origin_sq());
end

function test_main_local_helper_shadows_workspace()
  % Main-file local function with the same name as a workspace
  % function: numbl's resolver picks the main-local first (MATLAB
  % precedence). The cross-runner agrees, so this is a good check
  % that mtoc2 doesn't accidentally win the workspace target.
  disp(local_helper(2));
end

function y = local_helper(x)
  y = x + 1000;
end

function test_workspace_func_calls_workspace_func()
  % helper.m's `helper` reaches another sibling, `double_it.m`. The
  % resolver must work for calls originating from a non-main-file
  % function too.
  disp(chained(4));
end

function test_workspace_method_calls_workspace_func()
  % A class method calling a sibling workspace function.
  p = Point(3, 4);
  disp(p.shifted(double_it(5)).x);
end
