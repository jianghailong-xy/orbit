import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cross-project task moves have one decision card, the crossing decision card from the
 * handoff-in-chat board (`CrossingDecisionCard.tsx`, drawn in the asking session and in the target
 * project's coordinator). The owner decided on 2026-11-12 that there is no second move card: this
 * keeps the earlier `TaskMoveCard` from coming back under that name or its DOM hook.
 */

const root = [join(process.cwd(), 'src'), join(process.cwd(), 'src/web/src')].find((dir) => {
  try {
    return statSync(join(dir, 'components', 'CrossingDecisionCard.tsx')).isFile();
  } catch {
    return false;
  }
})!;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const self = 'components/noSecondMoveCard.test.ts';

describe('one decision card for task moves', () => {
  const files = sources(root).map((path) => relative(root, path));

  it('has no TaskMoveCard or taskMoves module', () => {
    expect(files.filter((file) => /TaskMoveCard|(^|\/)taskMoves\.ts$/.test(file))).toEqual([]);
  });

  it('no source names the removed card or its hooks', () => {
    const offenders = files
      .filter((file) => file !== self)
      .filter((file) =>
        /TaskMoveCard|useSessionTaskMoveInserts|data-task-move-batch|revealTaskMoveCard|lib\/taskMoves/.test(
          readFileSync(join(root, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('the batch door is called from the crossing decision card alone', () => {
    const callers = files
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => /api\(\s*`[^`]*\/task-moves\/decision`/.test(readFileSync(join(root, file), 'utf8')));
    expect(callers).toEqual(['components/CrossingDecisionCard.tsx']);
  });
});
