test_basic_helper();
test_per_file_scope();
test_helper_calls_helper();

function test_basic_helper()
  c = Counter(0);
  disp(c.bump(5));   % add_one(5) = 6
end

function test_per_file_scope()
  % bump.m's add_one returns x+1; boost.m's add_one returns x+10.
  % Calling each method picks the right helper.
  c = Counter(100);
  disp(c.bump(5));   % 6 + 100 = 106
  disp(c.boost(5));  % 15 + 100 = 115
end

function test_helper_calls_helper()
  c = Counter(7);
  disp(c.chain(2));  % wrap(2)=inner(2)*2=204, +7 = 211
end
