test_warning_plain();
test_warning_with_args();
test_warning_with_id();

function test_warning_plain()
  warning('plain message');
end

function test_warning_with_args()
  warning('count is %d', 42);
  warning('a=%d b=%g', 7, 3.14);
end

function test_warning_with_id()
  warning('topic:bad', 'identifier-bearing %d', 11);
end
