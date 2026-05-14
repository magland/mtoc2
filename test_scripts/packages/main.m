test_basic_pkg_call();
test_nested_pkg_call();
test_pkg_to_pkg_call();
test_two_packages_same_basename();
test_pkg_func_handle();
test_pkg_handle_through_local();

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
