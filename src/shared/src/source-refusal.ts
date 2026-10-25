import type { SourceFixAction } from './source';

/**
 * What to do about a refused start, in the words a person acts on.
 *
 * ONE SENTENCE, TWO READERS. The refusal is recorded twice — on the task (`task.dispatchRefusal`,
 * `dispatchRefusalComment`) and on the session (its SOURCE is REFUSED, carrying the code and the
 * runner's own words) — and the two are read by different people on different screens: a
 * coordinator or an owner reading the task's timeline, and whoever has the conversation open
 * reading the card the clients draw above an empty transcript. Those two must not give different
 * advice about one refusal, so the sentence lives here, in the package all of them already
 * import, and neither side keeps a second copy of it (SR49's reasoning, applied to prose: a
 * pairing re-derived per reader is a pairing free to drift).
 *
 * The advice is one step per `fixAction` and it is deliberately not "start it again", which is the
 * thing a generic failure note says and the one thing that cannot help: a new start resolves the
 * same selector against the same configuration and meets the same gate. Every branch says what has
 * to change first, and then says that starting again before it changes nothing.
 */
export function dispatchRefusalNextStep(
  refusal: { fixAction: SourceFixAction | string; ref: string | null },
): string {
  const again = 'Until then, a new start meets the same refusal.';
  const line = refusal.ref ? `the integration line ${branchName(refusal.ref)}` : 'the line this run starts from';
  switch (refusal.fixAction) {
    case 'SYNC_INTEGRATION_LINE':
      return (
        `The dependency has landed — what is missing is its landed commit on ${line}: the dependency's work `
        + 'reached upstream, and this line has not taken in upstream yet. Bring this line up to date with '
        + 'upstream first (the main sync at the next task landing does that; if it cannot wait, merge upstream '
        + 'into this line from its tip and push it back, with no rebase and no force push), then start it. '
        + 'Until then, a new start meets the same refusal: it begins from the same tip and asks for the same '
        + 'commits.'
      );
    case 'FIX_REF':
      // §10.1's one code whose cause is the line itself: there is nothing to sync and nothing to
      // restore, the ref the run was told to start from simply is not there. Said without naming a
      // gate, because the answer is the same whether the runner found that out with `ls-remote`
      // before a pin or with a checkout after one.
      return (
        `The repository had no ${refusal.ref ? `\`${refusal.ref}\`` : 'ref for this run to start from'} when `
        + 'it was resolved: it does not exist yet, it was deleted, or it does not match the name in the '
        + `project's binding. Create it first (this project's first landing on this line creates it), or `
        + `change the binding's integrationRef to the one that exists, then start it. ${again}`
      );
    case 'RESTORE_COMMIT':
      return (
        'The repository of the runner that runs it does not have the pinned commit: fetch or restore it '
        + `into that repository, then start it. ${again}`
      );
    case 'ENABLE_ISOLATION':
      return (
        'The runner could not create a separate worktree at the pinned commit: check that '
        + `this workspace's workDir is a git repository and that worktree isolation is not turned off, `
        + 'and work through the `git worktree add` error in '
        + `the runner's own words above, then start it. ${again}`
      );
    default:
      return `Fix it as ${refusal.fixAction} says, then start it. ${again}`;
  }
}

/** `refs/heads/x` as a reader says it, without the machinery. Same rule as the apiserver's
 *  `branchName` (projects/project-criterion-landing.ts), which is not importable from here. */
function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
