/**
 * The namespace a failed landing is handed to its task's own work session in
 * (projects/landing-fix-turn.ts `landingFixTurnId`, docs/project-integration-line-contract.md §12.5 W6):
 * `landing-fix:v1:<jobId>`. The one platform prefix that may revive an ended session — one that ended
 * because its task was done (sessions/platform-turn-revival.ts).
 *
 * In a module that imports nothing, so the open-item and integration-job modules can read it without loading
 * `watch-turn-key.ts`, whose imports reach back to them (`run-question.ts` → `project-open-item.ts`).
 */
export const LANDING_FIX_TURN_KEY_PREFIX = 'landing-fix:v1:';
