// Writers for a scenario's recording. Everything passes the Redactor on the way out.
//   protocol.ndjson — every event of every process in the scenario, in order
//   <fixture>/stdin.jsonl, stdout.jsonl, stderr.txt, meta.json — one process, for replay tests
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeProtocol(file, scenario, recorder, redactor) {
  const lines = recorder.events.map(e => JSON.stringify({ scenario, seq: e.seq, t: e.t, proc: e.proc, channel: e.channel, value: redactor.value(e.value) }));
  appendFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return lines.length;
}

export function writeFixture(dir, proc, recorder, redactor, meta) {
  mkdirSync(dir, { recursive: true });
  const mine = recorder.events.filter(e => e.proc === proc);
  const pick = channel => mine.filter(e => e.channel === channel).map(e => JSON.stringify(redactor.value(e.value))).join('\n');
  const stdin = pick('client->agent');
  const stdout = pick('agent->client');
  writeFileSync(join(dir, 'stdin.jsonl'), stdin + (stdin ? '\n' : ''));
  writeFileSync(join(dir, 'stdout.jsonl'), stdout + (stdout ? '\n' : ''));
  writeFileSync(join(dir, 'stderr.txt'), mine.filter(e => e.channel === 'stderr').map(e => redactor.text(e.value)).join('\n'));
  // The driver's actions in order, so a replay test can reproduce timing-dependent steps
  // (a prompt sent mid-turn, a signal, stdin closed) against the recorded output.
  const actions = mine.filter(e => !['agent->client', 'stderr'].includes(e.channel)).map(e => ({
    t: e.t, channel: e.channel,
    ...(e.channel === 'client->agent' ? { id: e.value.id, method: e.value.method ?? null } : { value: redactor.value(e.value) }),
  }));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(redactor.value({ ...meta, actions }), null, 1) + '\n');
}
