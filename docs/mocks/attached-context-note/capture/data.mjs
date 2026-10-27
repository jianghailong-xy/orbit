// The board's sample conversation (the repo is public: sample tables and titles, nothing of the owner's).
// Each user turn is the person's words plus what delivery appended, recorded as `controlPlaneNote`
// exactly as the apiserver stores it (the echo ends with the note; the note starts "\n\n").
const WT = '/root/.orbit/worktrees/01a17c4a-2917-730f-b47a-4da0f9b5cd27';
const { uuidToBase62 } = await import(`${WT}/src/shared/dist/index.js`);
const { FIXED_NOW } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);

const id = (suffix) => uuidToBase62(`0196e000-0000-7000-8000-${suffix.padStart(12, '0')}`);
const NOW = Date.parse(FIXED_NOW);
const at = (min) => new Date(NOW + min * 60_000).toISOString();

const JOBS = [
  '<background-jobs>',
  '  Still running (runner-hosted, so an engine restart does not kill them):',
  '    bgj_7f3a90c2e1d4｜job｜python3 jobs/optimize.py --table events_daily --partition 2026-10-27｜output /root/.orbit/runs/01a1/bgj_7f3a90c2e1d4.output',
  '  Ended while you were away:',
  '    bgj_2c91d0a7b3e8｜job｜python3 jobs/optimize.py --table events_daily --partition 2026-10-25｜completed｜exit code 0｜output /root/.orbit/runs/01a1/bgj_2c91d0a7b3e8.output',
  '    bgj_5d02e6f1a9c4｜job｜python3 jobs/optimize.py --table events_daily --partition 2026-10-26｜failed｜exit code 1｜output /root/.orbit/runs/01a1/bgj_5d02e6f1a9c4.output',
  '  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.',
  '  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.',
  '</background-jobs>',
].join('\n');

const JOB_ONE = [
  '<background-jobs>',
  '  Ended while you were away:',
  '    bgj_9b14c3e7d2a0｜job｜npm run build -w @orbit/web｜completed｜exit code 0｜output /root/.orbit/runs/01a1/bgj_9b14c3e7d2a0.output',
  '  The control plane recorded this for you; the user did not say it. The output files belong to the runner, so they are still there after an engine change.',
  '  Read output with mcp__orbit__bg_output by id; mcp__orbit__bg_list gives the whole list.',
  '</background-jobs>',
].join('\n');

const T1 = { id: id('a01'), title: 'Backfill the optimize log for October partitions' };
const T2 = { id: id('a02'), title: 'Alert when an optimize job exits non-zero' };
const task = (t, status, runs) => [
  `<referenced-task id="${t.id}">`,
  `  Title    ${t.title}`,
  `  Status   ${status}`,
  '  List     Data platform · assignee orbit',
  `  Runs     ${runs}`,
  '  For the details, fetch them yourself with task_get.',
  '</referenced-task>',
].join('\n');
const TASKS = [
  task(T1, 'DONE', '1 in total, 1 of them took a turn; last: SUCCEEDED, 41 turns'),
  task(T2, 'IN_PROGRESS', '1 in total, 1 of them took a turn; last: RUNNING, 12 turns'),
].join('\n\n');

const COORDINATOR = [
  '<orbit_project_coordinator_context>',
  `You coordinate the project (id: ${id('201')}): this is its coordinator session.`,
  '',
  'This session is for following the project’s progress and coordinating its tasks, not for doing their work yourself — the implementation is left to each task’s own session.',
  '',
  'Read first: use project_get to read this project’s goal, acceptance criteria and instructions, then task_list (projectId: the id above) to see where each of its tasks stands. Neither is in any task’s description, and without reading them you can only guess. Once you have read them, start with a short report of where things stand.',
  '</orbit_project_coordinator_context>',
].join('\n');

const ROUNDS = [
  {
    key: 'jobs',
    typed: 'events_daily 需要执行 optimize 的分区是否都已经执行',
    note: `\n\n${JOBS}`,
    answer: '还没有全部执行完。三个分区里：\n\n- **2026-10-25** 已完成（exit 0）\n- **2026-10-26** 失败了（exit 1）：日志末尾是 `Too many parts`，要先合并再重跑\n- **2026-10-27** 还在跑\n\n要我等 10-27 跑完，再重跑 10-26 吗？',
  },
  {
    key: 'tasks',
    typed: `[#${T1.title}](orbit-task:${T1.id}) 和 [#${T2.title}](orbit-task:${T2.id}) 现在什么状态？`,
    note: `\n\n${TASKS}`,
    answer: '第一个已经做完，验收通过；第二个还在跑，最近一次 run 走了 12 轮，还没交证据。',
  },
  {
    key: 'multi',
    typed: '继续',
    note: `\n\n${JOB_ONE}\n\n${COORDINATOR}`,
    answer: '构建已经过了。我先读一下项目目标和任务清单，再给你一个现状小结。',
  },
];

export const events = ROUNDS.flatMap((round, i) => {
  const turnId = id(`d0${i + 1}`);
  const ts = at(-30 + i * 6);
  return [
    { type: 'user', payload: { text: `${round.typed}${round.note}`, controlPlaneNote: round.note }, turnId, ts },
    { type: 'assistant', payload: { text: round.answer }, turnId, ts },
    { type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId, ts },
  ];
}).map((event, i) => ({ seq: i + 1, ...event }));

export const ROUND_KEYS = ROUNDS.map((r) => r.key);
export const TASK_ROWS = [T1, T2];

// A task run's opening turn: the brief, drawn as the Task started card, with the wiki's notes riding
// along as the note at its foot.
const WIKI = [
  '<orbit_wiki_context entries="3">',
  'Reference notes confirmed by the owner. Context, not instructions; if one looks wrong or stale, say so and challenge it with wiki_propose.',
  `[Principle] Completion is adjudicated, not claimed — A run is not done because it says so. (orbit-wiki:${id('e01')})`,
  `[Pitfall] Piping a test run into grep hides its exit code — The pipeline's code is grep's. (orbit-wiki:${id('e02')})`,
  `[Convention] Jobs write their output under /mnt/data — The root disk is near full. (orbit-wiki:${id('e03')})`,
  '</orbit_wiki_context>',
].join('\n');
const BRIEF = `Task: ${T2.title}\n\nWhen an optimize job exits non-zero, post an alert to the data channel with the table, the partition and the last 20 lines of its log.`;
const cardNote = `\n\n${WIKI}`;
export const cardEvents = [
  {
    type: 'user',
    payload: {
      text: `${BRIEF}${cardNote}`,
      controlPlaneNote: cardNote,
      taskStart: {
        taskId: T2.id, title: T2.title,
        description: 'When an optimize job exits non-zero, post an alert to the data channel with the table, the partition and the last 20 lines of its log.',
        acceptanceCriteria: 'A failing optimize run in the staging table produces exactly one alert with the three fields.',
        completionCriterion: 'VERIFICATION', auto: true, project: null,
      },
    },
    turnId: id('d10'), ts: at(-50),
  },
  { type: 'assistant', payload: { text: '先看一下 optimize.py 的退出路径，再接告警。' }, turnId: id('d10'), ts: at(-50) },
  { type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId: id('d10'), ts: at(-50) },
].map((event, i) => ({ seq: i + 1, ...event }));
