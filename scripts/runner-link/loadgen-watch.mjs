#!/usr/bin/env node
// The load test's watchers (task O3; docs/runner-link-design.md §5.9, §9): SSE clients on running sessions of a
// staging stack's fleet, as people with a session open in the app. Each stream makes the stack's apiserver count a
// watcher, subscribe to the session's live stream on NATS (ses.<id>.live) and tell the session's runner so
// (WatchersHint), which the loadgen's runners answer with live deltas (-live-rate, src/link-gateway/cmd/loadgen/live.go).
// It counts what reaches it and how late: the stream merges the deltas of each 50 ms and gives a delta no time
// (src/apiserver/src/sessions/coalesce-deltas.ts, sessions.controller.ts), so each delta's text starts with when the
// loadgen produced it, `@@<unix ms>@@`, and the deltas are counted, and timed, from the text.
//
// loadgen-run.sh --watch N starts it, after sourcing staging-lib.sh, whose guard refuses any Compose project but
// orbit-link-*; it checks the project its state directory names again itself. Each owner's access token is signed with
// the stack's own secret, read from the state directory (<state>/secrets/jwt_secret) and from nowhere else.
//
//   node scripts/runner-link/loadgen-watch.mjs <state dir> <api origin> <sessions file> <out dir>
//
// The sessions file has a line per session: its id, its owner's id and its owner's email, separated by spaces. It runs
// until SIGTERM or SIGINT, then writes watch.json. Every 10 s it adds a line to watch.jsonl: the interval (from, t), its
// messages by type, deltas, their delay as a histogram of whole milliseconds, streams open, opened and ended, and errors
// by kind; the last line, written as it stops (final), covers what came after the last interval.
// watch.json has the same over the whole run, how long each stream took to open (its response headers), and each
// session's streams: how often they opened and ended, the deltas and stored events they received, and the stored events
// they missed.
//
// LOADGEN_WATCH_STREAMS (1 unless set) opens that many streams of each session, as several tabs or devices would. A
// stream that ends opens again a second later, from the last stored event it received (sinceSeq), as the app's do: the
// stream then replays what it missed meanwhile, so `gaps` counts the stored events a stream never received, and
// `resumes` how long a stream went without a delta each time it ended: from its end to its first delta once open again.
import { createHmac } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [stateDir, api, sessionsFile, outDir] = process.argv.slice(2);
if (!stateDir || !api || !sessionsFile || !outDir) {
  console.error('usage: loadgen-watch.mjs <state dir> <api origin> <sessions file> <out dir>');
  process.exit(2);
}
// The stack's project, as staging-up.sh recorded it: an orbit-link-* stack and nothing else (staging-lib.sh).
const env = readFileSync(join(stateDir, 'compose.env'), 'utf8');
const project = /^STAGING_PROJECT=(.*)$/m.exec(env)?.[1] ?? '';
if (!/^orbit-link-[a-z0-9][a-z0-9_-]*$/.test(project)) {
  console.error(`loadgen-watch: ${stateDir} is not an orbit-link-* staging stack's state directory (project '${project}')`);
  process.exit(2);
}
const secret = readFileSync(join(stateDir, 'secrets', 'jwt_secret'), 'utf8').trim();
if (secret.length < 32) {
  console.error(`loadgen-watch: ${join(stateDir, 'secrets', 'jwt_secret')} holds no secret`);
  process.exit(2);
}
const sessions = readFileSync(sessionsFile, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 3);
if (sessions.length === 0) {
  console.error(`loadgen-watch: ${sessionsFile} names no session`);
  process.exit(2);
}
const streamsPerSession = Number(process.env.LOADGEN_WATCH_STREAMS ?? 1);
if (!Number.isInteger(streamsPerSession) || streamsPerSession < 1 || streamsPerSession > 8) {
  console.error('loadgen-watch: LOADGEN_WATCH_STREAMS is a number of streams per session, 1 to 8');
  process.exit(2);
}

// An access token as the apiserver signs one (auth.service.ts): HS256 over { sub, email }, for six hours.
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function accessToken(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: userId, email, iat: now, exp: now + 6 * 3600 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const stamp = /@@(\d{13})@@/g;
const newInterval = () => ({ messages: {}, deltas: 0, delayMs: {}, opened: 0, ended: 0, errors: {} });
let cur = newInterval();
const total = { ...newInterval(), openMs: [] };
const count = (key, map, n = 1) => {
  map[key] = (map[key] ?? 0) + n;
};
const error = (kind) => {
  count(kind, cur.errors);
  count(kind, total.errors);
};
let open = 0;
let stopping = false;
const controllers = new Set();

// sessionId -> what its streams received (watch.json's `sessions`).
const perSession = new Map();
const sessionStats = (id) => {
  let st = perSession.get(id);
  if (!st) {
    st = { opened: 0, ended: 0, deltas: 0, stored: 0, gaps: 0, lastDeltaAt: 0, resumes: [] };
    perSession.set(id, st);
  }
  return st;
};

// One stream's message. `stream.lastSeq` is the last stored event it received, which it resumes from: a stored event
// past the next one in line means the ones between never reached it.
function onMessage(data, now, st, stream) {
  let ev;
  try {
    ev = JSON.parse(data);
  } catch {
    error('unreadable_message');
    return;
  }
  const type = typeof ev?.type === 'string' ? ev.type : 'untyped';
  count(type, cur.messages);
  count(type, total.messages);
  const seq = Number(ev?.seq ?? 0);
  if (Number.isSafeInteger(seq) && seq > 0) {
    if (stream.lastSeq > 0 && seq > stream.lastSeq + 1) st.gaps += seq - stream.lastSeq - 1;
    if (seq > stream.lastSeq) {
      stream.lastSeq = seq;
      st.stored++;
    }
  }
  if (type !== 'text_delta') return;
  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  for (const m of text.matchAll(stamp)) {
    const delay = Math.max(0, Math.min(Math.round(now - Number(m[1])), 600_000));
    cur.deltas++;
    total.deltas++;
    st.deltas++;
    count(delay, cur.delayMs);
    count(delay, total.delayMs);
    if (stream.endedAt && !stream.resumedAt) {
      // This stream's first delta since it last ended, so on the connection that replaced the one that ended.
      st.resumes.push({ endedAt: stream.endedAt, reopenedAt: stream.reopenedAt, deltaAfterMs: now - stream.endedAt });
      stream.resumedAt = now;
    }
    st.lastDeltaAt = now;
  }
}

async function watch(id, userId, email) {
  const st = sessionStats(id);
  // What this stream has received, kept across its reconnects: where it resumes from, and when it last ended.
  const stream = { lastSeq: 0, endedAt: 0, reopenedAt: 0, resumedAt: 0 };
  while (!stopping) {
    const since = stream.lastSeq > 0 ? `&sinceSeq=${stream.lastSeq}` : '';
    const url = `${api}/api/sessions/${id}/events?access_token=${accessToken(userId, email)}${since}`;
    const ctl = new AbortController();
    controllers.add(ctl);
    const started = Date.now();
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctl.signal });
      if (res.status !== 200) {
        error(`http_${res.status}`);
        await res.body?.cancel();
      } else {
        open++;
        cur.opened++;
        total.opened++;
        st.opened++;
        total.openMs.push(Date.now() - started);
        if (stream.endedAt) stream.reopenedAt = Date.now();
        let buf = '';
        const decoder = new TextDecoder();
        try {
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, end);
              buf = buf.slice(end + 2);
              const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data) onMessage(data, Date.now(), st, stream);
            }
          }
        } finally {
          open--;
          cur.ended++;
          total.ended++;
          st.ended++;
          if (!stopping) Object.assign(stream, { endedAt: Date.now(), reopenedAt: 0, resumedAt: 0 });
        }
        if (!stopping) error('stream_ended');
      }
    } catch (err) {
      if (!stopping) error(err?.name === 'AbortError' ? 'aborted' : `fetch_failed_${err?.cause?.code ?? err?.name ?? 'unknown'}`);
    } finally {
      controllers.delete(ctl);
    }
    if (!stopping) await new Promise((r) => setTimeout(r, 1000));
  }
}

const series = join(outDir, 'watch.jsonl');
writeFileSync(series, '');
let from = Date.now();
const flush = (final = false) => {
  const t = Date.now();
  appendFileSync(series, JSON.stringify({ from, t, open, ...cur, ...(final ? { final: true } : {}) }) + '\n');
  from = t;
  cur = newInterval();
};
const timer = setInterval(flush, 10_000);
const startedAt = new Date().toISOString();
const watchers = sessions.flatMap(([id, userId, email]) =>
  Array.from({ length: streamsPerSession }, () => watch(id, userId, email)));
console.error(`loadgen-watch: watching ${sessions.length} sessions of ${project} at ${api}, ${streamsPerSession} stream(s) each`);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  for (const ctl of controllers) ctl.abort();
  await Promise.allSettled(watchers);
  flush(true);
  writeFileSync(join(outDir, 'watch.json'), JSON.stringify({
    project, api, sessions: sessions.length, streamsPerSession, startedAt, endedAt: new Date().toISOString(),
    streams: { opened: total.opened, ended: total.ended }, messages: total.messages, deltas: total.deltas,
    delayMs: total.delayMs, errors: total.errors, openMs: total.openMs.sort((a, b) => a - b),
    bySession: Object.fromEntries(perSession),
  }, null, 2) + '\n');
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
