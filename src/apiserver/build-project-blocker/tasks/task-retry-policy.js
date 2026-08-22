"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUOTA_BLIND_RETRY_BACKOFF_MS = exports.MAX_AUTO_RUN_FAILURES = exports.AUTO_RUN_RETRY_BACKOFF_MS = void 0;
exports.retryBackoffUntil = retryBackoffUntil;
// One retry policy, shared by the legacy task sweep and Project authorization. Keeping the
// numbers here prevents the Coordinator from growing a second retry ladder that only happens to
// have the same values today.
exports.AUTO_RUN_RETRY_BACKOFF_MS = [
    2 * 60_000,
    8 * 60_000,
    30 * 60_000,
    120 * 60_000,
];
exports.MAX_AUTO_RUN_FAILURES = exports.AUTO_RUN_RETRY_BACKOFF_MS.length + 1;
exports.QUOTA_BLIND_RETRY_BACKOFF_MS = 15 * 60_000;
function retryBackoffUntil(failureCount, lastFailureAt) {
    if (failureCount <= 0 || !lastFailureAt || failureCount >= exports.MAX_AUTO_RUN_FAILURES)
        return null;
    return new Date(lastFailureAt.getTime()
        + exports.AUTO_RUN_RETRY_BACKOFF_MS[Math.min(failureCount - 1, exports.AUTO_RUN_RETRY_BACKOFF_MS.length - 1)]);
}
//# sourceMappingURL=task-retry-policy.js.map