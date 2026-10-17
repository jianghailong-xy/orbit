import { useSyncExternalStore } from 'react';

// Global notifications belong to the top open modal's focus boundary. Register
// Orbit-owned elements instead of discovering a library's portal DOM.
const layers = new Map<HTMLElement, number>();
const listeners = new Set<() => void>();
let target: HTMLElement | null = null;

function update() {
  const next = [...layers].sort((a, b) => a[1] - b[1]).at(-1)?.[0] ?? null;
  if (next === target) return;
  target = next;
  for (const listener of listeners) listener();
}

export function registerFeedbackLayer(element: HTMLElement, level: number): () => void {
  layers.set(element, level);
  update();
  return () => { layers.delete(element); update(); };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFeedbackPortal() {
  return useSyncExternalStore(subscribe, () => target, () => null);
}
