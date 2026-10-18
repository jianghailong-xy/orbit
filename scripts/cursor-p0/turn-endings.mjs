#!/usr/bin/env node
// How every recorded turn ended, read from committed protocol recordings (no CLI, no prompt): for each
// session/prompt, its stopReason, its last agent_message_chunk and every chunk that starts with a blank
// line (the shape Cursor CLI ends a failed turn with, §12); and every session/update that arrived while
// no prompt of its session was open and no session/load was replaying. A sub-agent's own updates belong
// to the Task card that spawned it and are left out.
//   node scripts/cursor-p0/turn-endings.mjs <out.json> <protocol.ndjson>... [--classified <go test log> --classifier-test <file> --classifier-commit <sha>]
// --classified merges the lines `P0C\t<file>\t<proc>\t<stopReason>\t<chunk>\t=> <verdict>` that P5b's
// cursorTurnFailure printed for these turns (see docs/evidence/cursor-cli/2026.10.14-941492e/p0c/README.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const take = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const classifiedLog = take('--classified');
// The test that printed the verdicts, and the commit of the runner-go copy it ran in, are kept with them.
const classifierTest = take('--classifier-test'), classifierCommit = take('--classifier-commit');
const [out, ...files] = args;
const turns = [];
const outside = {};
const outsideOther = [];
for (const file of files) {
  const byProc = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (!byProc.has(e.proc)) byProc.set(e.proc, []);
    byProc.get(e.proc).push(e);
  }
  for (const [proc, events] of byProc) {
    const prompts = new Map(), loads = new Map(), news = new Set(), sessions = new Set(), subagents = new Set();
    const openPrompts = sid => [...prompts.values()].filter(p => p.session === sid);
    const loading = sid => [...loads.values()].includes(sid);
    for (const e of events) {
      const v = e.value;
      if (!v || typeof v !== 'object') continue;
      if (e.channel === 'client->agent') {
        if (v.method === 'session/prompt') prompts.set(v.id, { session: v.params.sessionId, seq: e.seq, chunks: [] });
        else if (v.method === 'session/load') loads.set(v.id, v.params.sessionId);
        else if (v.method === 'session/new') news.add(v.id);
        continue;
      }
      if (e.channel !== 'agent->client') continue;
      if (v.method === 'session/update') {
        const sid = v.params.sessionId, u = v.params.update, kind = u.sessionUpdate;
        if (kind === 'subagent_spawned') { subagents.add(u.subagentSessionId); subagents.add(u._meta?.cursor?.agentId); }
        if (subagents.has(sid)) continue;
        const open = openPrompts(sid);
        if (open.length) { if (kind === 'agent_message_chunk') for (const p of open) p.chunks.push(u.content?.text ?? ''); continue; }
        if (loading(sid)) continue;
        const key = sessions.has(sid) ? kind : `${kind} (session not opened by this process)`;
        outside[key] = (outside[key] ?? 0) + 1;
        if (!['session_info_update', 'available_commands_update', 'current_mode_update'].includes(kind)) outsideOther.push({ file: basename(file), proc, seq: e.seq, kind });
      } else if (v.id !== undefined && v.method === undefined) {
        if (news.has(v.id)) { news.delete(v.id); if (v.result?.sessionId) sessions.add(v.result.sessionId); }
        else if (prompts.has(v.id)) {
          const p = prompts.get(v.id);
          prompts.delete(v.id);
          turns.push(turn(file, proc, p, v.result?.stopReason ?? 'error', v.error));
        } else if (loads.has(v.id)) { sessions.add(loads.get(v.id)); loads.delete(v.id); }
      }
    }
    for (const p of prompts.values()) turns.push(turn(file, proc, p, 'unanswered'));
  }
}
if (classifiedLog) {
  const verdicts = readFileSync(classifiedLog, 'utf8').split('\n').filter(l => l.startsWith('P0C\t')).map(l => l.split('\t'));
  verdicts.forEach((cols, i) => {
    const t = turns[i];
    if (!t || cols[1] !== t.file || cols[2] !== t.proc) throw new Error(`classifier line ${i} does not match turn ${t?.file}/${t?.proc}`);
    t.p5bCursorTurnFailure = JSON.parse(cols[5].replace(/^=> /, ''));
  });
  if (verdicts.length !== turns.length) throw new Error(`classifier printed ${verdicts.length} lines for ${turns.length} turns`);
}
const classifier = classifiedLog ? { function: 'cursorTurnFailure (src/runner-go/cursor_events.go)', commit: classifierCommit, test: classifierTest ? readFileSync(classifierTest, 'utf8') : null } : null;
writeFileSync(out, JSON.stringify({ files: files.map(f => basename(f)), ...(classifier ? { classifier } : {}), turns, outsideAnyTurn: outside, outsideAnyTurnOtherKinds: outsideOther }, null, 1) + '\n');
console.log(`${turns.length} turns; chunks starting with a blank line: ${turns.filter(t => t.blankLineChunks.length).length} turns; outside any turn: ${JSON.stringify(outside)}`);

function turn(file, proc, p, stopReason, error) {
  return { file: basename(file), proc, promptSeq: p.seq, stopReason, ...(error ? { error } : {}), chunks: p.chunks.length,
    lastChunk: p.chunks.at(-1) ?? null, blankLineChunks: p.chunks.filter(c => c.startsWith('\n\n')) };
}
