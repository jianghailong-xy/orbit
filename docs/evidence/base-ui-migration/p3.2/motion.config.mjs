import { defineConfig } from '@playwright/test';
import pilot from './pilot.config.mjs';

// pilot.config.mjs with the browser's default motion setting instead of reduced motion: the replaced
// components animate under both settings (AntD does not read it), the Orbit ones only under this one,
// so the same-scenario timings are taken under each. Copy into src/web/ui-migration/ of the tree
// under test; it is not part of the delivery.
export default defineConfig({ ...pilot, use: { ...pilot.use, reducedMotion: 'no-preference' } });
