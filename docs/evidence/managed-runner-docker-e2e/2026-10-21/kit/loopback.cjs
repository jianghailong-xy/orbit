// Preloaded into the D4 test apiserver (node -r): a server this process opens on a port without naming a host
// listens on 127.0.0.1 only, not on every address as Nest's app.listen(port) would. Test harness only.
'use strict';
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const first = args[0];
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
  } else if (first && typeof first === 'object' && first.port !== undefined && !first.host && !first.path) {
    args[0] = { ...first, host: '127.0.0.1' };
  }
  return listen.apply(this, args);
};
