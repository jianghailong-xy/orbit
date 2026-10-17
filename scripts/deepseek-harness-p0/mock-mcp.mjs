// A real stdio MCP peer. Only writes in the disposable experiment directory.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const record = value => appendFileSync(process.env.P0_MCP_LOG, JSON.stringify(value) + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record({ direction: 'in', message });
  if (message.method === 'initialize') reply(message.id, {
    protocolVersion: message.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'orbit-p0-mock', version: '1' },
  });
  else if (message.method === 'tools/list') reply(message.id, { tools: [{
    name: 'record', description: 'Record a synthetic Orbit MCP side effect.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }] });
  else if (message.method === 'tools/call') {
    record({ effect: message.params.arguments.value, session: process.env.ORBIT_SESSION_ID });
    if (message.params.arguments.value !== 'hold')
      reply(message.id, { content: [{ type: 'text', text: 'recorded:' + message.params.arguments.value }] });
  } else if (message.id !== undefined) reply(message.id, {});
});
