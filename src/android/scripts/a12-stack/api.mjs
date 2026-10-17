// Tiny client for the isolated A12 stack: node <stack dir>/api.mjs METHOD PATH [json-body] [--as owner|other]
// Logs in through POST /api/auth/login with the test account from accounts.json and prints the JSON reply.
import { call, login, HttpError } from './lib.mjs';

const args = process.argv.slice(2);
const asIdx = args.indexOf('--as');
const who = asIdx >= 0 ? args.splice(asIdx, 2)[1] : 'owner';
const [method, path, body] = args;
if (!method || !path) {
  console.error('usage: node api.mjs METHOD PATH [json-body] [--as owner|other]');
  process.exit(2);
}
try {
  const out = await call(method.toUpperCase(), path, await login(who), body === undefined ? undefined : JSON.parse(body));
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  if (e instanceof HttpError) {
    console.error(`HTTP ${e.status}: ${e.body}`);
    process.exit(1);
  }
  throw e;
}
