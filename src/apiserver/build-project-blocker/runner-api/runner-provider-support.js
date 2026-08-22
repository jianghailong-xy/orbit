"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPENCODE_RUNNER_UPGRADE_ERROR = void 0;
exports.advertisedRunnerProviders = advertisedRunnerProviders;
exports.runnerAdvertisesProvider = runnerAdvertisesProvider;
const shared_1 = require("@orbit/shared");
exports.OPENCODE_RUNNER_UPGRADE_ERROR = 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first';
/** Parse the positive capability advertisement added to claim/reclaim in runner 0.1.82. */
function advertisedRunnerProviders(header) {
    const advertised = new Set((header ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
    return Object.values(shared_1.AgentProvider).filter((provider) => advertised.has(provider));
}
function runnerAdvertisesProvider(header, provider) {
    return advertisedRunnerProviders(header).includes(provider);
}
//# sourceMappingURL=runner-provider-support.js.map