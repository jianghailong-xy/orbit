import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { sessionIsWorking, sessionNeedsOwner } from './sessionGrouping';

// Needs you / Working membership only: runs unchanged on the tip and on the commit before the display change.
// Copy to src/web/src/lib/ and run with ROWS=<rows.json> OUT=<result.json>.
it('writes web group membership', () => {
  const rows = JSON.parse(readFileSync(process.env.ROWS!, 'utf8')).filter((r: any) => r.kind === 'fixture' || r.kind === 'listRow');
  writeFileSync(process.env.OUT!, JSON.stringify(rows.map((r: any) => ({
    id: r.id, needsYou: sessionNeedsOwner(r.payload), working: sessionIsWorking(r.payload),
  })), null, 1));
});
