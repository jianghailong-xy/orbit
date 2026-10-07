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
  const again = '在那之前重新开工只会得到同一个拒绝。';
  const line = refusal.ref ? `集成线 ${branchName(refusal.ref)}` : '这次起跑的线';
  switch (refusal.fixAction) {
    case 'SYNC_INTEGRATION_LINE':
      return (
        `前置已经落地了——缺的是它落地的提交不在${line}上：前置的成果进了 upstream，而这条线还没吸收 `
        + 'upstream。先让这条线追上它（下一次任务落地时的 main 同步会做；等不及就从这条线的 tip 出发把 '
        + 'upstream 合进来、推回这条线，不 rebase、不 force push），再开工。'
        + '在那之前重新开工只会得到同一个拒绝：新的开工从同一个 tip 起跑，要求的是同一组提交。'
      );
    case 'FIX_REF':
      // §10.1's one code whose cause is the line itself: there is nothing to sync and nothing to
      // restore, the ref the run was told to start from simply is not there. Said without naming a
      // gate, because the answer is the same whether the runner found that out with `ls-remote`
      // before a pin or with a checkout after one.
      return (
        `解析的时候仓库里没有 ${refusal.ref ? `\`${refusal.ref}\`` : '这次起跑要用的 ref'}：`
        + '它还不存在、已经被删掉，或者和项目绑定里的名字对不上。先把它建出来'
        + '（这个项目在这条线上的第一次落地会创建它），或者把绑定的 integrationRef 改成实际存在的那一条，'
        + '再开工。' + again
      );
    case 'RESTORE_COMMIT':
      return '执行它的 runner 的仓库里没有这次钉住的提交：把它取回或恢复到那个仓库里，再开工。' + again;
    case 'ENABLE_ISOLATION':
      return (
        'runner 没能在钉住的提交上建出独立的 worktree：确认这个工作区的 workDir 是 git 仓库、'
        + '没有关掉 worktree 隔离，并按上面 runner 的原话排查 `git worktree add` 的报错，再开工。' + again
      );
    default:
      return `按处置 ${refusal.fixAction} 修好之后再开工。` + again;
  }
}

/** `refs/heads/x` as a reader says it, without the machinery. Same rule as the apiserver's
 *  `branchName` (projects/project-criterion-landing.ts), which is not importable from here. */
function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
