import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { sessionSendDispositionOf } from './sessionCapabilities';
import { isSessionTerminal } from './sessionState';
import { statusLabel } from '../components/WorkspaceView';
import { sessionStatusMeta } from '../components/TaskDetailPanel';

// Copy to src/web/src/lib/ of the checkout under test and run with FIXTURE=<fixture.json> OUT=<result.json>.
it('writes the web decisions for every fixture row', () => {
  const rows = JSON.parse(readFileSync(process.env.FIXTURE!, 'utf8'));
  const out = rows.map((r: any) => {
    const p = r.payload;
    return {
      name: r.name, newFields: r.newFields,
      send: (() => { try { return sessionSendDispositionOf(p, true); } catch (e) { return 'ERR ' + (e as Error).message; } })(),
      waitOver: isSessionTerminal(p),
      word: statusLabel(p),
      run: sessionStatusMeta(p).label,
    };
  });
  writeFileSync(process.env.OUT!, JSON.stringify(out, null, 1));
});
