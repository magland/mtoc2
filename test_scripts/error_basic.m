% error() codegen — verify all three shapes compile. The error sites
% themselves stay unreachable at runtime so both runners exit 0 and
% the cross-runner sees matching empty stdout up to the disp lines.

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
