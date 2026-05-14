% Formatted I/O: fprintf (basic + tensor), sprintf, error.

test_fprintf_basic();
test_fprintf_tensor();
test_sprintf_basic();
test_error_basic();

function test_fprintf_basic()
  % Plain literals, no args.
  fprintf('hello\n');
  fprintf('no newline ');
  fprintf('!\n');

  % Integer args.
  fprintf('nch = %d\n', 7);
  fprintf('a = %d, b = %d, c = %d\n', 1, 2, 3);

  % Float args with precision.
  x = 3.14159265358979;
  fprintf('pi = %.5f\n', x);
  fprintf('pi = %.12f\n', x);
  fprintf('pi = %g\n', x);

  % Vector cycled across format spec.
  v = [1.5, 2.5, 3.5];
  fprintf(' %.2f', v);
  fprintf('\n');

  % String / char in %s.
  fprintf('greet: %s!\n', 'world');
  fprintf('greet: %s!\n', "world");

  % Mixed numeric + text.
  fprintf('item=%s n=%d\n', 'x', 42);

  % Negative + zero-pad + width.
  fprintf('[%5d]\n', 7);
  fprintf('[%-5d]\n', 7);
  fprintf('[%05d]\n', 7);
  fprintf('[%+d]\n', 12);
end

function test_fprintf_tensor()
  % Single-arg row, cycled.
  v = [10, 20, 30, 40];
  fprintf('v[%d]=%d\n', 1:4, v);
  fprintf('\n');

  % Column vector.
  c = [1.0; 2.0; 3.0];
  fprintf('%.3f\n', c);

  % Matrix — column-major flatten.
  M = [1 2 3; 4 5 6];
  fprintf('%d ', M);
  fprintf('\n');

  % Mix: scalar then tensor.
  fprintf('first=%d then %d', 100, [7, 8, 9]);
  fprintf('\n');

  % %g on floats.
  xs = [0.0, 0.5, 1e-5, 1e10];
  fprintf('%g\n', xs);

  % Empty tensor — should produce no output (skipped).
  e = zeros(0, 3);
  fprintf('before\n');
  fprintf('%d\n', e);
  fprintf('after\n');
end

function test_sprintf_basic()
  % Char format → returns char; disp prints raw bytes.
  c = sprintf('a=%d b=%d', 1, 2);
  disp(c);

  % String format → returns string; disp prints raw bytes.
  s = sprintf("x = %.3f", 3.14159);
  disp(s);

  % sprintf with vector cycling.
  v = [1, 2, 3];
  t = sprintf('%d,', v);
  disp(t);

  % Empty format → empty result.
  e = sprintf('');
  disp(e);

  % Use sprintf result as fprintf format-substitute (via %s).
  msg = sprintf('count=%d', 42);
  fprintf('result: %s\n', msg);
end

function test_error_basic()
  % error() codegen — verify all three shapes compile. The error sites
  % stay unreachable at runtime (guarded by `if 0`) so both runners exit
  % 0 and the cross-runner sees matching empty stdout up to the disp
  % lines.

  % Shape 1: single message.
  disp('before-1');
  if 0
    error('something went wrong');
  end
  disp('after-1');

  % Shape 2: format + args.
  disp('before-2');
  if 0
    error('value %d is out of range', 42);
  end
  disp('after-2');

  % Shape 3: id + format + args.
  disp('before-3');
  n = 7;
  if 0
    error('mymod:badinput', 'n = %d (expected positive)', n);
  end
  disp('after-3');

  % Format-with-tensor — exercises the same flattening path fprintf uses.
  disp('before-4');
  v = [1, 2, 3];
  if 0
    error('items: %d', v);
  end
  disp('after-4');
end
