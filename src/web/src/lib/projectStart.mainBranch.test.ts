import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIN_BRANCH,
  RUN_AUTOMATIC_HINT_MAIN,
  RUN_AUTOMATIC_HINT_PROJECT_BRANCH,
  RUN_AUTOMATIC_OFF,
  RUN_AUTOMATIC_OFF_MAIN,
  RUN_AUTOMATIC_ON_CHECKED,
  RUN_AUTOMATIC_ON_MAIN,
  RUN_AUTOMATIC_ON_UNCHECKED,
  RUN_LINE_MAIN,
  RUN_LINE_MAIN_HINT,
  RUN_MAIN_BRANCH,
  RUN_MERGE_CHECK_HINT,
  RUN_NO_MERGE_CHECK_WARNING,
  RUN_PAUSE_HINT,
  START_EACH_MERGE_INTO_MAIN,
  START_MERGING_INTO_MAIN,
  mainBranchName,
  mainBranchRef,
  runAutomaticHint,
  runAutomaticSays,
  runLastChoiceFor,
  runLineInSentence,
  runLineLocked,
  runLineMain,
  runLineMainHint,
  runMainBranchLocked,
  runMainBranchRemembers,
  runMergeCheckHint,
  runNoMergeCheckWarning,
  runPauseHint,
  startComesToYou,
  startEachMergeInto,
  startMainBranch,
  startMergingInto,
} from './projectStart';

/**
 * Every sentence of the settings band that says where work goes names the project's main branch
 * (board ②⑨⑩): the 16 here, and the integration row's two (`ProjectIntegrationLine.test.tsx`). For
 * a project on `main` each reads word for word as it did before — the old text is written out below
 * as it stood — save the locked sentence under Main branch, whose half sentence "and its main
 * branch" is the one change the contract allows. The constants keep the old words, which OrbitKit's
 * copy-parity tests read; each function, at main, says its constant's words.
 */

/** The 16, each as a function of the main branch, with the words it said before there was one. */
const SENTENCES: Array<[string, (main?: string) => string, string]> = [
  ['the line, by name', runLineMain, 'Directly into main'],
  ['what the line means', runLineMainHint, 'For a single task or an urgent fix. Every merge into main asks you.'],
  ['Automatic on a project branch', (main) => runAutomaticHint('PROJECT_BRANCH', main),
    'The coordinator runs it for you: it decides when each task is done, handles conflicts and failed '
    + 'checks, and merges the branch into main once the merge check passes — with a receipt you can '
    + 'revert. The criteria and anything irreversible stay yours.'],
  ['Automatic directly into main', (main) => runAutomaticHint('MAIN', main),
    'The coordinator runs it for you: it decides when each task is done and handles conflicts and '
    + 'failed checks. Merging into main always asks you — a project that lands directly on main never '
    + 'merges by itself. The criteria and anything irreversible stay yours.'],
  ['the merge check', runMergeCheckHint,
    'Runs on the combined tree before anything lands — on the project branch and again before main.'],
  ['no merge check', runNoMergeCheckWarning,
    'No merge check: with Automatic on, the branch merges into main with nothing run on the combined tree.'],
  ['Automatic on, checked', (main) => runAutomaticSays(true, 'PROJECT_BRANCH', true, main),
    'The coordinator decides when each task is done and merges into main once the merge check passes '
    + '— with a receipt you can revert.'],
  ['Automatic on, unchecked', (main) => runAutomaticSays(true, 'PROJECT_BRANCH', false, main),
    'The coordinator decides when each task is done and merges into main by itself — with a receipt '
    + 'you can revert.'],
  ['Automatic on, directly into main', (main) => runAutomaticSays(true, 'MAIN', true, main),
    'The coordinator decides when each task is done. Each merge into main still asks you.'],
  ['Automatic off', (main) => runAutomaticSays(false, 'PROJECT_BRANCH', true, main),
    'You decide when each task is done and when the branch goes into main.'],
  ['Automatic off, directly into main', (main) => runAutomaticSays(false, 'MAIN', false, main),
    'You decide when each task is done, and each merge into main asks you.'],
  ['what comes to the owner: merging', startMergingInto, 'Merging the branch into main'],
  ['what comes to the owner: each merge', startEachMergeInto, 'Each merge into main'],
  ['the line mid-sentence', (main) => runLineInSentence('MAIN', main), 'directly into main'],
  ['what Pause stops', runPauseHint, 'Stops new tasks, wake-ups and merges into main. Running tasks finish.'],
  ['why the line is locked', (main) => runMainBranchLocked('2h ago', main),
    'This project started integrating 2h ago, so the line it lands on can no longer change. Merge it '
    + 'into main, or give up the branch, to start another.'],
];

describe('the main branch, in the words of the settings band', () => {
  it('says each of the 16 sentences word for word as before for a project on main', () => {
    expect(SENTENCES).toHaveLength(16);
    for (const [what, say, before] of SENTENCES) {
      const now = what === 'why the line is locked'
        ? before.replace('the line it lands on can', 'the line it lands on and its main branch can')
        : before;
      expect(say(), what).toBe(now);
      expect(say(DEFAULT_MAIN_BRANCH), what).toBe(now);
    }
    // The constants still say them of main, word for word, for the native copy-parity tests.
    expect([
      RUN_LINE_MAIN, RUN_LINE_MAIN_HINT, RUN_AUTOMATIC_HINT_PROJECT_BRANCH, RUN_AUTOMATIC_HINT_MAIN,
      RUN_MERGE_CHECK_HINT, RUN_NO_MERGE_CHECK_WARNING, RUN_AUTOMATIC_ON_CHECKED, RUN_AUTOMATIC_ON_UNCHECKED,
      RUN_AUTOMATIC_ON_MAIN, RUN_AUTOMATIC_OFF, RUN_AUTOMATIC_OFF_MAIN, START_MERGING_INTO_MAIN,
      START_EACH_MERGE_INTO_MAIN, RUN_PAUSE_HINT,
    ]).toEqual(SENTENCES.slice(0, 13).map(([, say]) => say()).concat(SENTENCES[14]![1]()));
  });

  it('names master wherever it said main, and nowhere else, for a project on master', () => {
    for (const [what, say, before] of SENTENCES) {
      const now = what === 'why the line is locked'
        ? before.replace('the line it lands on can', 'the line it lands on and its main branch can')
        : before;
      expect(say('master'), what).toBe(now.replaceAll(/\bmain\b/gu, 'master').replace('its master branch', 'its main branch'));
    }
    expect(runLineMain('master')).toBe('Directly into master');
    expect(runMainBranchLocked(null, 'master')).toBe(
      'This project started integrating, so the line it lands on and its main branch can no longer '
      + 'change. Merge it into master, or give up the branch, to start another.');
    expect(runAutomaticHint('MAIN', 'develop')).toContain(
      'Merging into develop always asks you — a project that lands directly on develop never merges by itself.');
  });

  it('keeps the line’s own lock sentence, for a project with no Main branch row, as it always read', () => {
    expect(runLineLocked('2h ago')).toBe(
      'This project started integrating 2h ago, so the line it lands on can no longer change. Merge it '
      + 'into main, or give up the branch, to start another.');
    expect(runLineLocked(null)).toBe(
      'This project started integrating, so the line it lands on can no longer change. Merge it into '
      + 'main, or give up the branch, to start another.');
  });

  it('lists what comes to the owner by the project’s main branch', () => {
    const base = { ownerConfirmed: [], evidenceJudged: 0, escalationSeconds: 7_200 };
    expect(startComesToYou({ ...base, automatic: true, line: 'MAIN', main: 'master' })[0])
      .toEqual({ text: 'Each merge into master', detail: null });
    expect(startComesToYou({ ...base, automatic: false, line: 'PROJECT_BRANCH', main: 'master' })
      .map((item) => item.text)).toContain('Merging the branch into master');
    expect(startComesToYou({ ...base, automatic: false, line: 'PROJECT_BRANCH' }).map((item) => item.text))
      .toContain('Merging the branch into main');
  });

  it('says the Main branch row’s own words', () => {
    expect(RUN_MAIN_BRANCH).toBe('Main branch');
    expect(runLastChoiceFor('acme/payments-api')).toBe('Your last choice for acme/payments-api');
    expect(runMainBranchRemembers('acme/payments-api')).toBe(
      'New projects in acme/payments-api start with your last choice.');
  });

  it('takes a main branch by name and gives it to the doors as a full ref', () => {
    expect(mainBranchRef('master')).toBe('refs/heads/master');
    expect(mainBranchRef('release/2.4')).toBe('refs/heads/release/2.4');
    expect(mainBranchName('refs/heads/release/2.4')).toBe('release/2.4');
    expect(mainBranchName('master')).toBe('master');
    expect(mainBranchName(null)).toBe('main');
    expect(mainBranchName(undefined)).toBe('main');
  });
});

describe('the main branch a start opens with', () => {
  const chosen = { upstreamRef: 'trunk', upstreamChosenAt: '2026-10-08T01:00:00.000Z' };
  const last = { branch: 'develop', repository: 'acme/payments-api', chosenAt: '2026-10-07T01:00:00.000Z' };

  it('is this project’s own choice first, then the last choice for its repository, then the suggestion, then main', () => {
    expect(startMainBranch('refs/heads/master', { ...chosen, lastMainBranch: last })).toBe('trunk');
    expect(startMainBranch('refs/heads/master', { upstreamRef: 'main', upstreamChosenAt: null, lastMainBranch: last }))
      .toBe('develop');
    expect(startMainBranch('refs/heads/master', { upstreamRef: 'main', upstreamChosenAt: null, lastMainBranch: null }))
      .toBe('master');
    expect(startMainBranch(undefined, { upstreamRef: 'main', upstreamChosenAt: null, lastMainBranch: null }))
      .toBe('main');
  });

  it('takes a main branch the project only stands on by default as nobody’s choice', () => {
    // Bound to its repository with the default, never chosen: the suggestion still decides.
    expect(startMainBranch('refs/heads/master', { upstreamRef: 'main', upstreamChosenAt: null }))
      .toBe('master');
    // A server that predates the memory says nothing of it, and a read that failed says nothing at all.
    expect(startMainBranch('refs/heads/master', null)).toBe('master');
    expect(startMainBranch(undefined, null)).toBe('main');
  });
});
