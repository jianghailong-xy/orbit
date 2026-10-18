// What dispatch makes of a Cursor CLI model value written as a variant, on the server this tree builds:
// resolveProviderExec (src/apiserver/src/providers/custom-provider.ts) against a catalogue the way the
// runner reports the parameterized picker's — bare model names. Run from src/apiserver after
// `npx tsc -p tsconfig.test.json`:
//
//   node ../../docs/evidence/cursor-engine/p7a-variants/retired-pin-probe.cjs
const { resolveProviderExec } = require(process.cwd() + '/build/providers/custom-provider.js');

const catalog = { cursor: [
  { value: 'default', label: 'Auto' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    parameters: [{ id: 'context', label: 'Context', values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }] }] },
] };
for (const sessionModel of ['claude-opus-5-5', 'claude-opus-5-5[context=1m,fast=true]']) {
  const exec = resolveProviderExec({ engine: 'cursor', declaredProvider: 'cursor', declaredProviderBuiltin: true, customRow: null,
    sessionModel, modelCatalog: catalog });
  console.log(JSON.stringify(sessionModel), '->', JSON.stringify(exec.model), exec.retiredPin ? '(retiredPin)' : '');
}
