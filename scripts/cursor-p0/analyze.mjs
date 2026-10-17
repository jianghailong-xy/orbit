#!/usr/bin/env node
// Post-hoc analysis of recorded runs, for scenarios whose run-time checks were wrong: a harness
// bug (the session store was read without its WAL, so the scenario threw after its prompt) or an
// expectation the real CLI disproved (plan/ask modes are not read-only). It reads the committed
// protocol recordings and, where a check needs a file the turn wrote, the run directory under
// /mnt/data/cursor-p0/runs/<runId>/. No CLI process is started and no prompt is sent.
//   node scripts/cursor-p0/analyze.mjs   -> docs/evidence/cursor-cli/<version>/analysis/<scenario>.json
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, P0_ROOT } from './lib/env.mjs';
import { ScenarioContext } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const evidence = join(here, '..', '..', 'docs', 'evidence', 'cursor-cli', VERSION);
const outDir = join(evidence, 'analysis');
mkdirSync(outDir, { recursive: true });

const scenario = name => JSON.parse(readFileSync(join(evidence, 'scenarios', `${name}.json`), 'utf8'));
const events = name => readFileSync(join(evidence, 'protocol', `${name}.ndjson`), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// Tool cards, permission requests, extension requests, prompt results and text, per session.
function digest(evs) {
  const tools = new Map(), perms = [], ext = [], results = [], text = {}, kinds = {};
  for (const e of evs) {
    const v = e.value;
    if (e.channel !== 'agent->client' || !v || typeof v !== 'object') continue;
    if (v.method === 'session/request_permission') perms.push({ seq: e.seq, sessionId: v.params.sessionId, title: v.params.toolCall?.title, kind: v.params.toolCall?.kind, options: v.params.options?.map(o => o.optionId) });
    else if (v.method?.startsWith('cursor/')) ext.push({ seq: e.seq, method: v.method, hasId: v.id !== undefined, params: v.params });
    else if (v.method === 'session/update') {
      const u = v.params.update, sid = v.params.sessionId;
      kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1;
      if (u.sessionUpdate === 'agent_message_chunk') text[sid] = (text[sid] ?? '') + (u.content?.text ?? '');
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const t = tools.get(u.toolCallId) ?? { sessionId: sid, firstSeq: e.seq, statuses: [] };
        for (const k of ['title', 'kind', 'rawOutput', 'rawInput']) if (u[k] !== undefined) t[k] = u[k];
        if (u.status) t.statuses.push(u.status);
        t.lastSeq = e.seq;
        tools.set(u.toolCallId, t);
      }
    } else if (v.id !== undefined && v.result?.stopReason) results.push({ seq: e.seq, id: v.id, stopReason: v.result.stopReason });
  }
  return { tools: [...tools.values()], perms, ext, results, text, kinds };
}

const store = (configDir, name) => {
  const sessions = join(configDir, 'acp-sessions');
  if (!existsSync(sessions)) return null;
  const sid = readdirSync(sessions).find(s => existsSync(join(sessions, s, 'store.db')));
  if (!sid) return null;
  const ctx = new ScenarioContext({ name: `analyze-${name}`, runId: 'analysis', runRoot: join(P0_ROOT, 'analysis-scratch'), fixturesDir: join(P0_ROOT, 'analysis-scratch', 'fixtures'), key: 'analysis-placeholder-key' });
  return ctx.storeBlobs(configDir, sid);
};
const lines = f => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

function write(name, reason, checks, facts) {
  const s = scenario(name);
  const result = { scenario: name, runId: s.runId, recordedAt: s.finishedAt, reason, basis: 'committed protocol recording (seq numbers below) plus files the recorded turn left in its run directory', checks, facts };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 1) + '\n');
  console.log(`${name}: ${checks.filter(c => c.ok).length}/${checks.length} corrected checks hold`);
}
const check = (name, ok, detail) => ({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });

// 1. multi-turn-tools-default: the orbit check wrongly required the model to repeat the task title.
{
  const name = 'multi-turn-tools-default';
  const d = digest(events(name));
  const orbit = d.tools.find(t => /orbit/i.test(t.title ?? '') && /task_get/.test(t.title ?? ''));
  const ask = d.perms.find(p => /task_get/.test(p.title ?? ''));
  write(name, 'The run-time check also demanded that the model quote the task title; ACP never carries MCP result content (rawOutput is {success:true}), so that part was not a property of the CLI.', [
    check('`orbit mcp` injected through session/new mcpServers: task_get raised a permission request', !!ask, ask),
    check('…and the tool card completed with rawOutput {success:true}', orbit?.statuses.includes('completed') && orbit?.rawOutput?.success === true, orbit),
  ], { orbitToolCard: orbit, permissionRequest: ask });
}

// 2/3. permission-force and permission-auto-review threw while reading the store (WAL not copied).
for (const name of ['permission-force', 'permission-auto-review']) {
  const s = scenario(name);
  const d = digest(events(name));
  const run = join(P0_ROOT, 'runs', s.runId, name);
  const prefix = name === 'permission-force' ? 'force' : 'auto';
  const marker = name === 'permission-force' ? 'force-mode' : 'auto-review';
  const files = ['write', 'shell'].map(k => `${prefix}-${k}.txt`).filter(f => existsSync(join(run, 'work', f)));
  const effects = lines(join(run, 'mcp-effects.log')).filter(e => e.marker === marker).length;
  const meta = store(join(run, 'slots', 'a', 'cursor-config'), name)?.meta?.[0]?.value ?? null;
  const checks = name === 'permission-force' ? [
    check('--force: no session/request_permission at all', d.perms.length === 0, d.perms),
    check('--force: the workspace write and the `touch` both happened', files.length === 2, files),
    check('--force: the MCP record tool ran once', effects === 1, effects),
    check('--force: the fetch tool card completed', d.tools.some(t => t.kind === 'fetch' && t.statuses.includes('completed'))),
    check('the session store records isRunEverything: true', meta?.isRunEverything === true, meta && { isRunEverything: meta.isRunEverything, mode: meta.mode }),
  ] : [
    check('--auto-review on the ACP path: `touch` still asks', d.perms.some(p => /touch/.test(p.title ?? '')), d.perms.map(p => p.title)),
    check('…the MCP call still asks', d.perms.some(p => p.kind === 'other')),
    check('…the fetch still asks', d.perms.some(p => p.kind === 'fetch')),
    check('…the workspace write does not ask (same as the default allowlist)', files.includes('auto-write.txt') && !d.perms.some(p => p.kind === 'edit'), files),
    check('the session store records mode default and isRunEverything false', meta?.mode === 'default' && meta?.isRunEverything === false, meta && { isRunEverything: meta.isRunEverything, mode: meta.mode }),
  ];
  write(name, 'The scenario read the session store without its -wal file, found no tables and threw before its checks ran (fixed in lib/harness.mjs). The prompt itself completed and is fully recorded.', checks,
    { permissionRequests: d.perms, toolCards: d.tools.map(t => ({ title: t.title, kind: t.kind, statuses: t.statuses })), files, mcpEffects: effects, stopReasons: d.results });
}

// 4. plan-and-ask-modes-concurrent: the expectation "plan and ask are read-only" was wrong.
{
  const name = 'plan-and-ask-modes-concurrent';
  const s = scenario(name);
  const evs = events(name);
  const d = digest(evs);
  const run = join(P0_ROOT, 'runs', s.runId, name);
  const sessions = [...new Set(d.perms.map(p => p.sessionId))];
  const bySession = sid => d.tools.filter(t => t.sessionId === sid);
  // Which session is plan: the one whose cards mention plan-*.
  const planSid = d.tools.find(t => /plan-(write|shell)/.test(t.title ?? ''))?.sessionId;
  const askSid = d.tools.find(t => /ask-(write|shell)/.test(t.title ?? ''))?.sessionId;
  const exists = f => existsSync(join(run, 'work', f));
  const effects = lines(join(run, 'mcp-effects.log')).map(e => e.marker);
  const planUpdate = evs.find(e => e.value?.params?.update?.sessionUpdate === 'plan');
  write(name, 'The run-time checks expected plan and ask mode to stop writes, shell commands and MCP calls. The real CLI did not; these are the corrected checks, stating what it did.', [
    check('plan mode: the edit tool ran but the file was not written', bySession(planSid).some(t => t.kind === 'edit') && !exists('plan-write.txt')),
    check('plan mode: `touch` raised a permission request and, once allowed, ran', d.perms.some(p => p.sessionId === planSid && /touch/.test(p.title ?? '')) && exists('plan-shell.txt')),
    check('plan mode: the MCP call raised a permission request and, once allowed, ran', d.perms.some(p => p.sessionId === planSid && p.kind === 'other') && effects.includes('plan-mode')),
    check('plan mode: a `plan` session/update and a cursor/create_plan request arrived', !!planUpdate && d.ext.some(x => x.method === 'cursor/create_plan')),
    check('ask mode: the workspace write happened without any permission request', exists('ask-write.txt') && !d.perms.some(p => p.sessionId === askSid && p.kind === 'edit')),
    check('ask mode: `touch` raised a permission request and, once allowed, ran', d.perms.some(p => p.sessionId === askSid && /touch/.test(p.title ?? '')) && exists('ask-shell.txt')),
    check('ask mode: the MCP call raised a permission request and, once allowed, ran', d.perms.some(p => p.sessionId === askSid && p.kind === 'other') && effects.includes('ask-mode')),
  ], { planSession: planSid, askSession: askSid, sessionsAsking: sessions, files: readdirSync(join(run, 'work')).filter(f => !f.startsWith('.')), mcpEffects: effects,
    planUpdate: planUpdate?.value?.params?.update, createPlan: d.ext.filter(x => x.method === 'cursor/create_plan'), planText: d.text[planSid]?.slice(-300), askText: d.text[askSid]?.slice(-300) });
}

// 5. background-shell-and-commit: the account ran out of free requests; the turn is a quota sample.
{
  const name = 'background-shell-and-commit';
  const d = digest(events(name));
  const txt = Object.values(d.text).join('');
  write(name, 'The prompt hit the Free plan\'s request limit, so no commit and no background shell happened. Recorded instead: the exact shape of an exhausted quota.', [
    check('quota exhausted: the prompt answers end_turn', d.results.length === 1 && d.results[0].stopReason === 'end_turn', d.results),
    check('…carrying only the text "Upgrade your plan to continue" as agent_message_chunk', /Upgrade your plan to continue/.test(txt) && d.tools.length === 0, txt),
    check('…with no JSON-RPC error and no tool call', !events(name).some(e => e.value?.error) && d.tools.length === 0),
  ], { text: txt, updateKinds: d.kinds, serverError: 'see incidents/quota-exhausted/README.md (decoded from the CLI debug log)' });
}

// 6. ask-question: the server offered no AskQuestion tool in ACP agent mode.
{
  const name = 'ask-question';
  const d = digest(events(name));
  const txt = Object.values(d.text).join('');
  write(name, 'The scenario expected the model to call AskQuestion. In ACP agent mode the server offered no such tool (the model said so and asked in plain text), so cursor/ask_question was never sent; its handling stays unverified.', [
    check('no cursor/ask_question request arrived', !d.ext.some(x => x.method === 'cursor/ask_question')),
    check('the model reported that AskQuestion is not available and asked in plain text', /AskQuestion isn.t available|ask conversationally/i.test(txt), txt.slice(-200)),
  ], { text: txt.slice(-600), permissionRequests: d.perms.map(p => ({ title: p.title, kind: p.kind })) });
}

// 7. crash-recover-and-move: the interrupted call's error result is written by the next prompt.
{
  const name = 'crash-recover-and-move';
  const s = scenario(name);
  const cont = join(P0_ROOT, 'runs', s.runId, 'crash-continue-and-shell-wrapper', 'slots', 'c', 'cursor-config');
  const st = store(cont, 'crash-continue');
  const tool = st?.blobs?.find(b => b.json.role === 'tool')?.json?.content?.[0];
  write(name, 'The run-time check looked for the interrupted call\'s tool result right after session/load; the CLI writes it when the next prompt is sent, which the same run\'s continuation did.', [
    check('after load + the next prompt, the store holds an error result for the interrupted shell call', /interrupted/i.test(tool?.result ?? ''), tool?.result),
  ], { toolResult: tool && { toolName: tool.toolName, result: tool.result }, roles: st?.blobs?.map(b => b.json.role) });
}

// 8. crash-continue-and-shell-wrapper: the wrapper was named without "bash", so the CLI never used it.
{
  const name = 'crash-continue-and-shell-wrapper';
  const s = scenario(name);
  write(name, 'The wrapper was named orbit-shell. The CLI uses $SHELL only when that path contains "bash" (or "zsh"; index.js@7385715 `t?.includes("bash")?t:…`) and otherwise runs bash from PATH, so the wrapper never ran. The recall half of the scenario passed.', [
    check('recall after crash + move passed in the recorded run', s.checks.some(c => /continues with its context/.test(c.name) && c.ok)),
    check('agent commands kept the CLI\'s HOME and every Cursor variable (wrapper unused)', s.detail?.['agent command environment under the SHELL wrapper']?.names?.includes('CURSOR_API_KEY')),
  ], { recorded: s.detail });
}
