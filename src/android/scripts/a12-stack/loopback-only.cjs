// Preloaded with `node --require` (not part of the built tree): src/apiserver/src/main.ts calls
// app.listen(port) with no host, which binds every interface. This pins that one port to 127.0.0.1.
const net = require('node:net');
const http = require('node:http');
const PORT = Number(process.env.PORT);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if ((typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) && Number(first) === PORT) {
    if (typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
  } else if (first && typeof first === 'object' && Number(first.port) === PORT && !first.host) {
    args[0] = { ...first, host: '127.0.0.1' };
  }
  // Gateway parity: production clients reach the apiserver through the nginx gateway, whose keepalive_timeout is
  // nginx's default 75 s. Node's own 5 s would close pooled connections the app (OkHttp,
  // retryOnConnectionFailure=false) still reuses — a stack artefact, not a product path. Set before listening.
  if (this instanceof http.Server && ((typeof first === 'number' || typeof first === 'string') ? Number(first) : Number(first && first.port)) === PORT) {
    this.keepAliveTimeout = 75_000;
    this.headersTimeout = 76_000;
  }
  return listen.apply(this, args);
};
