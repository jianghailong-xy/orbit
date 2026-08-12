import type { ReportedEngine, RunnerEngineUpdate } from '@orbit/shared';

/**
 * Facts about a runner's engine CLIs that two pages both need, owned by neither.
 *
 * The Providers page asks which engines are signed in; the runner's own page asks what is
 * installed on that machine and whether it is current. Those are different questions about the
 * same four CLIs, so the rule for reading an update record lives here rather than in whichever
 * page happened to render it first.
 */

/** The CLIs' own product names. Keyed by ReportedEngine so a page that shows every engine on a
 *  machine can't quietly omit one, and so the sign-in table stays a narrowing of this. */
export const ENGINE_CLI_NAME: Record<ReportedEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long an engine may go without a successful update before that becomes the row's problem.
 *  Orbit tries daily, so a week is six missed passes — well past a bad night on the network. */
const STALE_UPDATE_MS = 7 * DAY;

export function ago(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

/**
 * What a row says about being kept current — the answer to a question a version number can't
 * settle on its own ("is 2.1.220 the new one?" is unanswerable; "9d behind 2.1.228" isn't).
 *
 * `quiet` is a footnote in the meta line. `warn` means this machine has actually drifted and only
 * a person can say why, so it earns colour and a panel. Everything routine stays quiet — a daily
 * job that reports success loudly is a daily job people learn to stop reading.
 */
export function updateNoteOf(
  update: RunnerEngineUpdate | undefined,
  now: number = Date.now(),
): { tone: 'quiet' | 'warn'; text: string } | null {
  if (!update) return null;
  // Orbit deliberately isn't updating this one. There is more than one reason it might not be
  // — a package manager owns the install, or it belongs to a user this runner isn't — and this
  // line is too short to hold either. So it states only the part that is true of all of them,
  // and the runner's own sentence (which names the path and the owner) rides along as a tooltip.
  // Naming one reason here was worse than naming none: a Kimi skipped for permissions still read
  // "updated by its package manager", promising an updater that did not exist.
  if (update.status === 'skipped') return { tone: 'quiet', text: 'not auto-updated' };
  // Drift decides first, because it is the reading taken on the binary. The rule underneath used
  // to be "a clean run in the last week means updating works here", and it was wrong in the one
  // case that matters: a machine that can't download anything still runs clean every day nothing
  // is published, so its week never expired and the row stayed quiet for as long as the release
  // schedule was quiet. Being behind is true regardless of what the last command returned.
  const behindSince = update.behindSince ? Date.parse(update.behindSince) : NaN;
  if (!Number.isNaN(behindSince)) {
    const days = Math.max(1, Math.floor((now - behindSince) / DAY));
    if (now - behindSince > STALE_UPDATE_MS) {
      return { tone: 'warn', text: `${days}d behind${update.latest ? ` ${update.latest}` : ''}` };
    }
    // Behind, but only just — which is the normal state of an engine that ships most days. Worth
    // a footnote naming what's coming, not an alarm.
    return {
      tone: 'quiet',
      text:
        update.status === 'failed'
          ? 'last update failed · retrying daily'
          : update.latest
            ? `updating to ${update.latest}`
            : 'update pending',
    };
  }
  const parsed = update.okAt ? Date.parse(update.okAt) : NaN;
  const lastOk = Number.isNaN(parsed) ? null : parsed;
  if (lastOk !== null && now - lastOk <= STALE_UPDATE_MS) {
    // Current, or nothing to compare against. A failure since the last clean run is worth a word
    // but not an alarm: the daily pass retries on its own, and most of these are a network blip.
    if (update.status === 'failed') return { tone: 'quiet', text: 'last update failed · retrying daily' };
    // "checked" and "updated" are different claims and are worth different words — the whole
    // point of splitting them is that a row can no longer say "updated 5m ago" about a pass that
    // did nothing but ask.
    return {
      tone: 'quiet',
      text: `${update.status === 'checked' ? 'checked' : 'updated'} ${ago(update.at, now)}`,
    };
  }
  // Nothing has landed in a week and no drift is being measured — an old runner, or one whose
  // release feed it can't reach. Erroring every night and never running at all look the same from
  // here and have the same consequence: a CLI drifting behind the models it's handed.
  return {
    tone: 'warn',
    text:
      lastOk === null
        ? 'never updated'
        : `not updated in ${Math.max(1, Math.floor((now - lastOk) / DAY))}d`,
  };
}
