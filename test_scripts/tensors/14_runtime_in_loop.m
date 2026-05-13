for k = 1:3
  disp([k k*10 k*100]);
end

s = 0;
for k = 1:4
  v = [k k+1 k+2];
  disp(v);
  s = s + k;
end
disp(s);
