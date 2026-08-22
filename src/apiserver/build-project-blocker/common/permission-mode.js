"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALWAYS_ALLOWED_TOOLS = exports.DEFAULT_PERMISSION_MODE = void 0;
exports.accountDefaultPermissionMode = accountDefaultPermissionMode;
exports.resolvePermissionMode = resolvePermissionMode;
const shared_1 = require("@orbit/shared");
/**
 * How much freedom a run gets when nobody said.
 *
 * The permission posture is a property of the RUN, not of the checkout it happens in: the same
 * directory wants Plan for a risky migration and Auto for a test fix. So the authoritative value
 * is `Session.permissionMode`, and what a workspace used to hold was only the seed for it. That
 * seed now lives on the account (UserPreferences.defaultPermissionMode), one place a user can
 * change instead of one per directory.
 *
 * The floor when neither is set is AUTO — the mode that runs without asking. It is deliberately
 * the *code* default only: migration 0094 backfilled every existing account from the narrowest
 * mode any of its workspaces used, so no one who was being asked for approval silently stopped
 * being asked. New accounts, which have no such history, start here.
 */
exports.DEFAULT_PERMISSION_MODE = shared_1.PermissionMode.AUTO;
/**
 * Tools every session may use without raising an approval card.
 *
 * Only Orbit's own MCP server is on it: it is injected into every session, and under an
 * ask-me mode its tools would otherwise prompt the user to approve Orbit talking to Orbit.
 *
 * This used to be `Workspace.allowedTools`, a per-directory column — but in production not one
 * row ever held anything else: every single one was exactly this list, written by the server on
 * create. A column whose value is a constant is a constant, so it moved here (migration 0094).
 */
exports.ALWAYS_ALLOWED_TOOLS = ['mcp__orbit__*'];
function accountDefaultPermissionMode(owner) {
    const prefs = (owner?.preferences ?? {});
    const mode = prefs.defaultPermissionMode;
    // Only a value this server still understands: an unknown string (older/newer client, hand-edited
    // row) must fall through to the floor rather than reach a runtime that cannot honour it.
    return Object.values(shared_1.PermissionMode).includes(mode ?? '')
        ? mode
        : undefined;
}
/** Session intent wins; else the owner's account default; else the floor. */
function resolvePermissionMode(sessionMode, owner) {
    return (sessionMode ??
        accountDefaultPermissionMode(owner) ??
        exports.DEFAULT_PERMISSION_MODE);
}
//# sourceMappingURL=permission-mode.js.map