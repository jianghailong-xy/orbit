import { CLAUDE_REGION_UNSUPPORTED, CLAUDE_REGIONS_SOURCE_URL, claudeRegionRefusedError } from '@orbit/shared';

/**
 * The words of the Claude region check on the web (docs/claude-region-check-contract.md, "Copy of
 * record"; board 02 and board 04 of docs/mocks/claude-region-check). `{machine}` is the runner's name
 * and `{region}` is `runner.region.name`, never a place read out of a sentence.
 *
 * Kept apart from runnerCopy.ts, which OrbitKit's and Android's copy tests read line by line.
 */

/** Anthropic's own page, linked wherever a sentence says Anthropic doesn't offer Claude somewhere. */
export const CLAUDE_REGION_SUPPORTED_REGIONS = 'Supported regions';
export const CLAUDE_REGION_SUPPORTED_REGIONS_URL = CLAUDE_REGIONS_SOURCE_URL;

/** The session card's why. */
export const claudeRegionCantUseAnthropicOn = (machine: string): string => `Claude Code can’t use Anthropic on ${machine}`;

/** The session card's body: the refusal sentence behind its code (contract §9), from the one shared
 *  writer, so the card and the server's sentence cannot drift apart. */
export const claudeRegionConnectionIsIn = (machine: string, region: string): string =>
  claudeRegionRefusedError(machine, region).slice(`${CLAUDE_REGION_UNSUPPORTED}: `.length);

/** The session card's subject line: the code and the place's ISO code. */
export const claudeRegionSubject = (code: string | null): string =>
  code ? `${CLAUDE_REGION_UNSUPPORTED} · ${code}` : CLAUDE_REGION_UNSUPPORTED;

/** When the region was last checked, and where Claude's connection came out: the session card's
 *  machine words, and the second line under the machine page's note. */
export const claudeRegionChecked = (when: string, region: string, viaProxy: boolean): string =>
  `Checked ${when} · Claude’s connection: ${region} (${viaProxy ? 'through a proxy' : 'no proxy'})`;

/** The session card's three ways out. */
export const CLAUDE_REGION_USE_ANOTHER_PROVIDER = 'Use another provider';
export const CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE = 'Move to another machine';
export const CLAUDE_REGION_CHECK_AGAIN = 'Check again';

/** A held session's status words, in the session list and the header. */
export const anthropicUnavailableOn = (machine: string): string => `Anthropic unavailable on ${machine}`;

/** The machine page: the attention line, the Claude Code row's badge and the note under the row. */
export const CLAUDE_REGION_ATTENTION = 'Claude Code can’t use Anthropic here';
export const CLAUDE_REGION_NOT_SUPPORTED = 'Region not supported';
export const claudeRegionMachineNote = (region: string): string =>
  `Claude’s connection from this machine is in ${region}, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys.`;
/** The attention item's detail, as a machine page's Needs Attention card says it (board 03). */
export const claudeRegionAttentionDetail = (region: string): string => `Anthropic doesn’t offer Claude in ${region}.`;
/** How many Claude accounts the machine keeps, on a row none of them can run on. */
export const claudeRegionAccounts = (count: number): string => `${count} ${count === 1 ? 'account' : 'accounts'}`;

/** The new session hero's link where nothing on the page fixes the reason: it explains instead. */
export const CLAUDE_REGION_DETAILS = 'Details';

/** Check again could not be asked for (the runner went offline, or is too old to check). */
export const CLAUDE_REGION_CHECK_FAILED = 'Couldn’t check again';
