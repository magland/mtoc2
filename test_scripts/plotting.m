% Plotting dispatch — every plotting builtin routes through
% `mtoc2_plot_dispatch`, emitting one `\x1emtoc2:plot\t…\n` record
% on stdout per call. The cross-runner globally drops those lines
% before comparing to numbl (which accumulates the same calls into
% its in-memory instruction list and writes nothing to stdout), so
% both runners' visible stdout is just the disp lines below.

test_drawing_primitives();
test_decoration_stubs();
test_zero_arg_ident_forms();
test_interleaved_with_disp();
test_text_args_as_char_and_string();
test_after_normal_arithmetic();

function test_drawing_primitives()
  x = 1:5;
  y = x .* 2;
  plot(x, y);
  plot(x, y, 'r--');
  scatter(x, y);
  bar(x, y);
  errorbar(x, y, y);
  semilogx(x, y);
  semilogy(x, y);
  loglog(x, y);
  % stem(x, y);  % numbl has no stem builtin yet — re-enable when added
  stairs(x, y);
  M = [1 2 3; 4 5 6];
  imagesc(M);
  surf(M);
  contour(M);
  quiver(x, y, x, y);
  disp(1);
end

function test_decoration_stubs()
  figure(1);
  hold('on');
  hold('off');
  title('plot title');
  xlabel('x axis');
  ylabel('y axis');
  zlabel('z axis');
  sgtitle('top');
  legend('a', 'b');
  colorbar();
  colormap('parula');
  shading('flat');
  subplot(2, 1, 1);
  % axis([0 10 0 20]);  % numbl only supports the string form (axis('equal'))
  xlim([0 10]);
  ylim([0 20]);
  grid('on');
  drawnow();
  disp(2);
end

function test_zero_arg_ident_forms()
  % Bare-identifier syntax for zero-arity void-returning builtins —
  % handled in `lowerIdent` via the arityAccepts(0) gate. Also
  % covers the parenthesized 0-arg form on the same names.
  figure;
  hold;
  drawnow;
  clf;
  % cla;  % numbl has no cla builtin yet — re-enable when added
  close();
  disp(3);
end

function test_interleaved_with_disp()
  for i = 1:3
    plot(i, i * i);
    fprintf('iter %d\n', i);
  end
end

function test_text_args_as_char_and_string()
  % MATLAB plot accepts both char ('r--') and string ("r--")
  % literals for line specs and property names; the wire format
  % flattens both to {"kind":"text",...}.
  plot([1 2 3], [4 5 6], 'r--');
  plot([1 2 3], [4 5 6], "b-.");
  title("a string title");
  xlabel('a char xlabel');
  legend('one', "two", 'three');
  disp(4);
end

function test_after_normal_arithmetic()
  a = 2 + 3;
  b = a * a;
  plot(1:b, sin(1:b));
  if b > 10
    disp(b);
  else
    disp(-b);
  end
end
