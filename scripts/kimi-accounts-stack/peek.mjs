// node peek.mjs <path> [jq-ish dot path] — GET an API path as the owner and print it.
import { call, login } from './lib.mjs';
const T = await login();
const out = await call('GET', process.argv[2], T, undefined, { quiet: true });
let v = out;
for (const k of (process.argv[3] || '').split('.').filter(Boolean)) v = v?.[k];
console.log(JSON.stringify(v, null, 1));
