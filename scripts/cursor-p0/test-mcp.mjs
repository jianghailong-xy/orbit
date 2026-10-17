#!/usr/bin/env node
// A stdio MCP server for the P0 experiments. It logs every message it receives, and its own
// launch, to the file named by P0_MCP_LOG (one JSON object per line), so a scenario can tell
// whether the CLI started it, listed its tools, and actually called one.
//   record  — appends {tool:'record', args} to the log and to P0_MCP_EFFECTS: a real side effect.
//   echo    — returns its text; no side effect.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.P0_MCP_LOG;
const effects = process.env.P0_MCP_EFFECTS;
const name = process.env.P0_MCP_NAME ?? 'p0probe';
const note = obj => { if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), server: name, ...obj }) + '\n'); };
note({ event: 'launch', pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HOME|PATH|ORBIT_|CURSOR_|AGENT_|XDG_|P0_)/.test(k))) });

const tools = [
  { name: 'record', description: 'Record a marker string in the P0 effects log. Has a side effect.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } },
  { name: 'echo', description: 'Echo the given text back. No side effect.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return note({ event: 'bad-line', line }); }
  note({ event: 'recv', method: msg.method, id: msg.id, params: msg.params });
  if (msg.id === undefined) return;
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } } });
    case 'tools/list':
      return send({ id: msg.id, result: { tools } });
    case 'tools/call': {
      const { name: tool, arguments: args = {} } = msg.params ?? {};
      if (tool === 'record') {
        if (effects) appendFileSync(effects, JSON.stringify({ at: new Date().toISOString(), server: name, marker: args.marker }) + '\n');
        return send({ id: msg.id, result: { content: [{ type: 'text', text: `recorded ${args.marker}` }] } });
      }
      if (tool === 'echo') return send({ id: msg.id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
      return send({ id: msg.id, error: { code: -32602, message: `unknown tool ${tool}` } });
    }
    case 'ping':
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
process.stdin.on('end', () => { note({ event: 'stdin-eof' }); process.exit(0); });
