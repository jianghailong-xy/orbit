import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Every place production code puts an item in front of the ACCOUNT OWNER announces it to their
 * devices (`docs/project-integration-line-contract.md` §7.6 V12).
 *
 * WHY THIS IS A CENSUS AND NOT A TEST OF ONE DOOR
 * ==============================================
 * `push.service.spec.ts` holds the rule — which four kinds ring a phone and which do not. What it
 * cannot see is a door that opens one of them and tells nobody, and that failure is invisible: a
 * card sitting on a project page, a project stopped on a person who was never told, which is the
 * stall this project exists to remove. The producers were written weeks apart by different tasks,
 * and nothing about the shape of a fifth would remind whoever adds it that the other four ring.
 *
 * So the obligation is checked over the tree. The scan is syntactic, over the same text a reviewer
 * reads: a file that assigns an item to `OWNER` has to be one of the ones listed here, and each
 * listed announcer has to carry the call. Adding a producer means adding a line here, which is
 * where the question "who tells them?" gets asked.
 */

// Resolved against the package root: this runs from `build/push`, and the subject is the
// TypeScript a reviewer reads.
const SRC = path.resolve(__dirname, '../../src');

/** An item handed to the owner, in the spelling every writer uses (`assignee: 'OWNER'`). */
const ASSIGNS_OWNER = /assignee:\s*'OWNER'/;
const ANNOUNCES = /\bnotifyOwnerItem\s*\(/;

/**
 * Where an item can become the owner's, and what answers "who tells them?" for each.
 *
 * `project-open-item.ts` is the pure writers — they run inside the transaction that wrote the fact
 * and may not reach a device from there; their callers announce after the commit, and those callers
 * are the announcers below. `owner-decision-signal.ts` is a READ of the same column.
 */
const OWNER_ITEM_WRITERS: Record<string, string> = {
  'projects/project-open-item.ts':
    'the in-transaction writers (recordTaskFailure, recordPromotionApproval, the drain that hands a '
    + 'queue over when a conversation ends); announced by the callers below, after their commit',
  'projects/project-open-item.service.ts': 'askOwner (R9) and handToOwner (X-D6), which announce here',
  'projects/project-fuse.service.ts': 'evaluate (F-T1), which announces after its transaction',
  'projects/owner-decision-signal.ts': 'a READ: it counts the owner’s items, it opens none',
};

/** Every file that must carry the announcement, and the fact each one announces. */
const ANNOUNCERS: Record<string, string> = {
  'projects/project-open-item.service.ts':
    'a question filed for the owner (R9), an item handed over when nobody can read it (X-D6), and '
    + 'a failure opened with the owner on it already (X-C3)',
  'projects/project-fuse.service.ts': 'the coordinator pausing itself (F-T1)',
  'projects/open-item-escalation.service.ts': 'the clock handing an item over (X-E1)',
  'runner-api/runner-api.controller.ts': 'the merge approval an integration result opened (M-T2)',
};

function sources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) {
        out.push({
          path: path.relative(SRC, full).split(path.sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

test('every door that hands an item to the owner is one that announces it', () => {
  const writers = sources()
    .filter((file) => ASSIGNS_OWNER.test(file.text))
    .map((file) => file.path)
    .sort();
  assert.ok(writers.length > 0, 'the scan found no owner-assigned item at all — it is broken');
  for (const file of writers) {
    assert.ok(
      OWNER_ITEM_WRITERS[file],
      `${file} puts an item in front of the account owner and is not listed in this census. `
        + 'Four kinds of owner item ring a phone (§7.6 V12): say here which of them this is and '
        + 'where the push for it goes, or the person it is waiting on is never told.',
    );
  }
});

test('each announcer still carries the call that tells the owner', () => {
  const byPath = new Map(sources().map((file) => [file.path, file.text]));
  for (const [file, what] of Object.entries(ANNOUNCERS)) {
    const text = byPath.get(file);
    assert.ok(text, `${file} is gone — if it moved, move this census with it`);
    assert.match(
      text,
      ANNOUNCES,
      `${file} no longer calls notifyOwnerItem: ${what} would be waiting on somebody nobody told.`,
    );
  }
});
