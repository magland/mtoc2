test_basic_pkg_call();
test_nested_pkg_call();
test_pkg_to_pkg_call();
test_two_packages_same_basename();
test_pkg_func_handle();
test_pkg_handle_through_local();
test_pkg_multi_assign();
test_anon_captures_through_pkg_call();
test_pkg_multi_drop_all();
test_handle_unify_distinguishes_qualified_targets();

function test_basic_pkg_call()
  % pkg.foo lives in +pkg/foo.m
  disp(pkg.foo(3));
  disp(pkg.foo(0));
end

function test_nested_pkg_call()
  % pkg.sub.baz lives in +pkg/+sub/baz.m — two namespace levels.
  disp(pkg.sub.baz(20));
end

function test_pkg_to_pkg_call()
  % +pkg/bar.m calls pkg.foo internally.
  disp(pkg.bar(2));
end

function test_two_packages_same_basename()
  % +pkg/foo.m and +other/foo.m both define a top-level foo. They
  % must mangle to distinct C names; specializing by file salts the
  % spec key so this works.
  disp(pkg.foo(5));
  disp(other.foo(5));
end

function test_pkg_func_handle()
  % @pkg.foo is a function handle to a packaged function.
  h = @pkg.foo;
  disp(h(7));
end

function test_pkg_handle_through_local()
  % Confirm that a handle to a packaged function survives capture
  % into an anonymous function.
  h = @pkg.foo;
  g = @(x) h(x) + 1;
  disp(g(4));
end

function test_pkg_multi_assign()
  % `[a, b] = pkg.pair(x)` — multi-output assign from a package
  % function. The AST RHS is a `MethodCall`, not a `FuncCall`; the
  % lowerer's multi-assign path accepts both shapes.
  [a, b] = pkg.pair(5);
  disp(a);
  disp(b);
end

function test_handle_unify_distinguishes_qualified_targets()
  % Two handles to package functions with the same BASENAME (foo)
  % but different QUALIFIED names (pkg.foo vs other.foo). Passing
  % them through `apply` must produce two distinct specializations
  % so each call routes to its own target. Previously
  % `HandleType.targetName` was set to the basename
  % (`target.ast.name`), so both handles canonicalized to the same
  % type, the spec key matched, and the second `apply` call reused
  % the first's spec body — silently calling pkg.foo where the
  % source asked for other.foo.
  disp(apply_handle(@pkg.foo, 5));   % pkg.foo(5)   = 51
  disp(apply_handle(@other.foo, 5)); % other.foo(5) = 4997
end

function y = apply_handle(h, x)
  y = h(x);
end

function test_pkg_multi_drop_all()
  % `pkg.pair(5);` — bare-statement form of a multi-output package
  % call. The `lowerExprStmt` peek must route MethodCall RHSs to the
  % drop-all multi-assign path (the same way it does for FuncCall),
  % otherwise lowerMethodCall throws because there is no value to
  % consume from an N>=2-output call.
  pkg.pair(5);
  disp(99);
end

function test_anon_captures_through_pkg_call()
  % An anonymous function body that calls a package function
  % (`pkg.foo`) must still discover captures referenced inside the
  % MethodCall args. Previously `collectAnonCaptures` had no
  % `MethodCall` case, so `a` was missed → body-lowering errored
  % "undefined variable 'a'".
  a = 100;
  f = @(x) pkg.takes2(x, a);
  disp(f(3));
end
