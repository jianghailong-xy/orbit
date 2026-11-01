import { generateKeyPairSync, sign, verify } from 'node:crypto';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// same shape as runner-link-token.ts:268 — verify(null, Buffer, keyObject, Buffer)
const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: 'runner-00000000-0000-0000-0000-000000000000', aud: 'link', exp: 1800000000, iat: 1799999000, nonce: 'abcdefghijklmnop' })).toString('base64url');
const input = Buffer.from(`${header}.${payload}`);
const sig = sign(null, input, privateKey);
for (let i = 0; i < 2000; i++) verify(null, input, publicKey, sig);   // warm up
const lat = [];
for (let i = 0; i < 20000; i++) {
  const t = process.hrtime.bigint();
  verify(null, input, publicKey, sig);
  lat.push(Number(process.hrtime.bigint() - t) / 1000);
}
lat.sort((a, b) => a - b);
const q = p => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
console.log(`node ${process.version}  ed25519 verify x${lat.length}: mean ${mean.toFixed(1)} us  p50 ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  p99 ${q(0.99).toFixed(1)}  -> ${(1e6/mean).toFixed(0)} verify/s`);
