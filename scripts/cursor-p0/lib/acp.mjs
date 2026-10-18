// A small ACP (JSON-RPC 2.0 over stdio) client for driving the real Cursor CLI (`agent acp`).
// Every byte in either direction is kept in a Recorder; nothing is printed here, so secrets
// only leave through the redacting writers in record.mjs.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Recorder {
  constructor() {
    this.t0 = Date.now();
    this.events = [];
  }
  add(proc, channel, value) {
    const event = { seq: this.events.length + 1, t: Date.now() - this.t0, proc, channel, value };
    this.events.push(event);
    return event;
  }
}

let procCounter = 0;

export class AcpProcess {
  // opts: { bin, args, env, cwd, recorder, label, onRequest, stderrSink }
  constructor(opts) {
    this.label = opts.label ?? `p${++procCounter}`;
    this.recorder = opts.recorder;
    this.onRequest = opts.onRequest ?? (() => undefined);
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.serverRequests = [];
    this.notifications = [];
    this.waiters = [];
    this.nonProtocol = [];
    this.stderr = '';
    this.exit = null;
    this.child = spawn(opts.bin, opts.args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.pid = this.child.pid;
    this.recorder.add(this.label, 'spawn', { args: opts.args, cwd: opts.cwd, envKeys: Object.keys(opts.env).sort() });
    this.exited = new Promise(resolve => {
      this.child.on('exit', (code, signal) => {
        this.exit = { code, signal };
        this.recorder.add(this.label, 'exit', this.exit);
        for (const [, p] of this.pending) p.resolve({ transportClosed: true });
        this.pending.clear();
        this.#wake();
        resolve(this.exit);
      });
      this.child.on('error', err => {
        this.recorder.add(this.label, 'spawn-error', String(err));
        this.exit = { code: null, signal: null, error: String(err) };
        resolve(this.exit);
      });
    });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => this.#onLine(line));
    createInterface({ input: this.child.stderr }).on('line', line => {
      this.stderr += line + '\n';
      this.recorder.add(this.label, 'stderr', line);
    });
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.nonProtocol.push(line);
      this.recorder.add(this.label, 'stdout/non-protocol', line);
      return;
    }
    this.recorder.add(this.label, 'agent->client', msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.serverRequests.push(msg);
      Promise.resolve(this.onRequest(msg, this)).then(reply => {
        if (reply === undefined || reply === null) return; // deliberately unanswered
        this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
      });
    } else if (msg.method !== undefined) {
      if (msg.method === 'session/update') this.updates.push(msg.params);
      else this.notifications.push(msg);
    }
    this.#wake();
  }

  #wake() {
    for (const w of [...this.waiters]) {
      if (w.check()) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(true);
      }
    }
  }

  write(msg) {
    if (this.exit) return false;
    this.recorder.add(this.label, 'client->agent', msg);
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  // Resolves with the raw response ({result} or {error}), {timeout:true}, or {transportClosed:true}.
  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return this.requestWithId(id, method, params, timeoutMs);
  }

  requestWithId(id, method, params, timeoutMs = 120000) {
    return new Promise(resolve => {
      if (this.exit) return resolve({ transportClosed: true });
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.recorder.add(this.label, 'client-timeout', { id, method, timeoutMs });
          resolve({ timeout: true });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    return this.write({ jsonrpc: '2.0', method, params });
  }

  waitFor(check, timeoutMs = 60000) {
    if (check()) return Promise.resolve(true);
    return new Promise(resolve => {
      const w = { check, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  updatesFor(sessionId) {
    return this.updates.filter(u => u.sessionId === sessionId).map(u => u.update);
  }

  closeStdin() {
    this.recorder.add(this.label, 'close-stdin', null);
    this.child.stdin.end();
  }

  signal(sig) {
    this.recorder.add(this.label, 'signal', sig);
    try {
      process.kill(this.pid, sig);
    } catch {}
  }

  // Kills the whole process group (the CLI starts helpers and shells of its own).
  killGroup(sig = 'SIGKILL') {
    try {
      process.kill(-this.pid, sig);
    } catch {}
  }

  async waitExit(timeoutMs = 30000) {
    let timer;
    const r = await Promise.race([this.exited, new Promise(res => { timer = setTimeout(() => res(null), timeoutMs); })]);
    clearTimeout(timer);
    return r;
  }

  async dispose() {
    if (!this.exit) {
      this.closeStdin();
      if (!(await this.waitExit(15000))) {
        this.signal('SIGTERM');
        if (!(await this.waitExit(10000))) {
          this.killGroup('SIGKILL');
          await this.waitExit(10000);
        }
      }
    }
    this.killGroup('SIGKILL');
  }
}

// Concatenated text of a session's message/thought chunks.
export function chunkText(updates, kind) {
  return updates.filter(u => u.sessionUpdate === kind).map(u => u.content?.text ?? '').join('');
}
