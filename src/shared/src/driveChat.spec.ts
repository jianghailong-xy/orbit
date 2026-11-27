import { describe, expect, it } from 'vitest';
import { driveChatGuidance } from './driveChat';

/** The tools that change the drive, and the kinds of change a Drive chat makes (board ③: one group, one Undo). */
const CHANGING_TOOLS = ['drive_move', 'drive_put', 'drive_delete'];
const CHANGES = ['a new folder', 'a move', 'a rename', 'a move to Trash', 'new content for a file'];

describe('driveChatGuidance', () => {
  it('on Orbit Cloud, reads ~/Files and makes every drive change through the drive_* tools only', () => {
    const lines = driveChatGuidance(true);
    const cloud = lines.find((line) => line.includes('~/Files'));
    expect(cloud).toBeDefined();
    expect(cloud).toMatch(/read it there with ordinary file commands/);
    expect(cloud).toMatch(/Make every change to the drive with the drive_\* tools, never with file commands on ~\/Files/);
    for (const change of CHANGES) expect(cloud).toContain(change);
    for (const tool of CHANGING_TOOLS) expect(cloud).toContain(tool);
    // Nothing tells it to change the drive with file commands any more.
    expect(lines.join('\n')).not.toMatch(/work on it there with ordinary file commands/);
  });

  it('off Orbit Cloud, works on the drive with the drive_* tools, and both say never to overwrite', () => {
    const local = driveChatGuidance(false);
    expect(local.some((line) => line.includes('~/Files'))).toBe(false);
    expect(local.find((line) => line.includes('drive_* tools'))).toMatch(/drive_list, drive_get, drive_put, drive_move, drive_delete/);
    for (const onCloud of [true, false]) {
      expect(driveChatGuidance(onCloud).some((line) => line.startsWith('Never overwrite a file with a same-named one.'))).toBe(true);
    }
    // The two differ only in the one line that says where the drive is.
    const cloud = driveChatGuidance(true);
    expect(cloud.length).toBe(local.length);
    expect(cloud.filter((line, i) => line !== local[i])).toHaveLength(1);
  });
});
