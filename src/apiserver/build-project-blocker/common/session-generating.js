"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERATING_SESSION_FILTER = exports.isSessionGenerating = void 0;
const client_1 = require("@prisma/client");
/**
 * Whether the engine is producing output for this session right now.
 *
 * RUNNING is the dispatched case. The second is a turn the runtime started for itself — a
 * background task reporting in, a scheduled wake-up — which never reaches /turn-complete and so
 * stays parked at AWAITING_INPUT for its whole duration (see Session.engineTurnActive).
 *
 * Deliberately a different question from `sessionHoldsRunnerSlot`: a self-driven turn acquired no
 * permit and must not be counted against a runner's concurrency. This one decides only what the
 * clients show — and which sessions can be holding a live approval, since a permission prompt
 * raised mid-wake-up needs answering exactly as much as one raised on a dispatched turn.
 *
 * Mirrors `isGenerating` in the web console and `Session.isGenerating` in OrbitKit.
 */
const isSessionGenerating = (session) => session.status === client_1.RunStatus.RUNNING ||
    (session.status === client_1.RunStatus.AWAITING_INPUT && session.engineTurnActive === true);
exports.isSessionGenerating = isSessionGenerating;
/** The same predicate as a Prisma filter, for counts that aggregate instead of fetching rows. */
exports.GENERATING_SESSION_FILTER = {
    OR: [
        { status: client_1.RunStatus.RUNNING },
        { status: client_1.RunStatus.AWAITING_INPUT, engineTurnActive: true },
    ],
};
//# sourceMappingURL=session-generating.js.map