import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { steerDeliveryState } from './steerDelivery';

/**
 * The words a steer's progress is reported in, checked against OrbitKit's copy of the same table.
 *
 * A mid-turn message produces no reply of its own — the running turn's is the answer — so how far
 * it got IS the whole visible outcome. Two people watching the same session from a browser and a
 * phone are watching the same message; if one says "Delivering…" while the other says something
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
    for (const delivery of [undefined, 'enqueued', 'written', 'acknowledged', 'failed']) {
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

  it('has a tone for each of the three things there are to say', () => {
    // progress / delivered / failed: on its way, in the conversation, never got there. A client
    // missing one of these has a state it cannot render.
    for (const tone of ['progress', 'delivered', 'failed']) {
      expect(SWIFT.includes(`case ${tone}`), `OrbitKit has no ${tone} tone`).toBe(true);
    }
  });
});
