import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deliveryFailureExplanation, steerDeliveryState } from './steerDelivery';

/**
 * The words a steer's progress is reported in, checked against OrbitKit's copy of the same table.
 *
 * A mid-turn message produces no reply of its own — the running turn's is the answer — so how far
 * it got IS the whole visible outcome. Two people watching the same session from a browser and a
 * phone are watching the same message; if one says "Waiting to be read" while the other says something
 * else, one of them is being told a different story about the same fact.
 *
 * Swift cannot import the TypeScript, so the table exists twice. This is what keeps the second
 * copy honest: change a label here and the Swift file has to change with it, or this fails naming
 * the word that drifted.
 */

const SWIFT = readFileSync(
  fileURLToPath(new URL('../../../macos/OrbitKit/Sources/OrbitKit/Transcript/SteerDelivery.swift', import.meta.url)),
  'utf8',
);

describe('steer delivery labels, web vs OrbitKit', () => {
  it('says the same word for every stage the runner reports', () => {
    // Undefined is the window before any event exists: accepted by the control plane, not yet
    // leased. It reads as the runner's own acceptance, which is the same promise.
    for (const delivery of [undefined, 'enqueued', 'written', 'acknowledged', 'requeued', 'failed']) {
      const { label, tone } = steerDeliveryState(delivery);
      expect(
        SWIFT.includes(`label: "${label}"`),
        `OrbitKit has no "${label}" (web says it for delivery=${delivery ?? 'none'})`,
      ).toBe(true);
      // The tone drives the colour, and a word shown in the wrong colour is its own wrong answer.
      expect(
        SWIFT.includes(`label: "${label}", tone: .${tone}`),
        `OrbitKit shows "${label}" in a different tone than web's ${tone}`,
      ).toBe(true);
    }
  });

  it('says the same words about the tray above the composer', () => {
    // docs/mocks/steer-tray: the same message, waiting in the same tray, on every client watching it.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const web = read('../components/PendingTray.tsx') + read('../components/WorkspaceView.tsx');
    const native =
      SWIFT
      + read('../../../macos/OrbitKit/Sources/OrbitKit/Transcript/PendingTray.swift')
      + read('../../../macos/OrbitApp/Sources/OrbitApp/Views/Console/PendingTrayView.swift')
      + read('../../../macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift')
      + read('../../../macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift');
    for (const words of [
      'Queued for next turn',
      'Withdrawing…',
      'Steer',
      'Send into the current turn now',
      'Withdraw — back to the composer',
      'Queue for next turn',
      "Couldn't send it into this turn",
      "This agent can't take a message mid-turn. It stays queued for the next turn.",
      'The turn is over or being stopped. It stays queued for the next turn.',
    ]) {
      expect(web.includes(words), `web has no "${words}"`).toBe(true);
      expect(native.includes(words), `the native clients have no "${words}"`).toBe(true);
    }
  });

  it('says the same words about a message that did not land', () => {
    // The owner's iOS boards, 2026-10-17: how a message's words come back to the composer, and why
    // it did not land, in the words every client uses.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const web = read('../components/Transcript.tsx') + read('../components/WorkspaceView.tsx');
    const native =
      read('../../../macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift')
      + read('../../../macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift');
    for (const words of ['Put back in the composer', "Couldn't discard the message"]) {
      expect(web.includes(words), `web has no "${words}"`).toBe(true);
      expect(native.includes(`"${words}"`), `OrbitApp has no "${words}"`).toBe(true);
    }
    for (const code of [
      'CURRENT_WORK_TARGET_COMPLETED',
      'CURRENT_WORK_INTERRUPTED',
      'CURRENT_WORK_SESSION_ENDED',
      'CURRENT_WORK_SESSION_FINALIZED',
      'CURRENT_WORK_SESSION_REAPED',
      'CURRENT_WORK_RUNTIME_REJECTED',
    ]) {
      const words = deliveryFailureExplanation(code);
      expect(SWIFT.includes(`return "${words}"`), `OrbitKit says otherwise than "${words}" for ${code}`).toBe(true);
    }
  });

  it('has a tone for each of the three things there are to say', () => {
    // progress / delivered / failed: on its way, in the conversation, never got there. A client
    // missing one of these has a state it cannot render.
    for (const tone of ['progress', 'delivered', 'failed']) {
      expect(SWIFT.includes(`case ${tone}`), `OrbitKit has no ${tone} tone`).toBe(true);
    }
  });
});
