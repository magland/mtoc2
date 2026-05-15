% planewave definitions

kvec = 20*[1;-1.5];
zk = norm(kvec);
planewave = @(kvec,r) exp(1i*sum(bsxfun(@times,kvec(:),r(:,:)))).';

% discretize domain

narms = 5;
amp = 0.5;
chnkr = chunkerfunc(@(t) starfish(t,narms,amp), 4/zk);

% build CFIE and solve

fkern = kernel('helm','c',zk,[1,-zk*1i]);
sysmat = chunkermat(chnkr,fkern);
sysmat = 0.5*eye(chnkr.k*chnkr.nch) + sysmat;

rhs = -planewave(kvec(:),chnkr.r(:,:));
sol = gmres(sysmat,rhs,[],1e-13,100);

% evaluate at targets

x1 = linspace(-3,3,400);
[xxtarg,yytarg] = meshgrid(x1,x1);
targets = [xxtarg(:).';yytarg(:).'];

in = chunkerinterior(chnkr,targets);
out = ~in;

uscat = chunkerkerneval(chnkr,fkern,sol,targets(:,out));

uin = planewave(kvec,targets(:,out));
utot = uscat(:)+planewave(kvec,targets(:,out));

% plot

maxu = max(abs(utot(:)));
figure()
zztarg = nan(size(xxtarg));
zztarg(out) = utot;
h=pcolor(xxtarg,yytarg,imag(zztarg));
set(h,'EdgeColor','none')
hold on
plot(chnkr,'LineWidth',2)
axis equal tight
colormap(redblue)
caxis([-maxu,maxu])

toc;