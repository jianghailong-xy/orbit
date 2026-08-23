import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskStatus } from '@prisma/client';

import {
  DEFAULT_FOLD_OPTIONS,
  foldProjectGraph,
  normalizeTitle,
  type FoldEdge,
  type FoldTask,
  type ProjectGraphMark,
} from './project-graph-fold';

/**
 * The fold, on the two shapes this database actually holds.
 *
 * Both fixtures below are miniatures of a real project: `chain()` is Linux From Scratch (one
 * component, 118 tasks, every task waiting on the one before it) and `batch()` is the FineWeb
 * pipeline (23,442 tasks that are one four-step motif instantiated 6,118 times). The properties
 * asserted are the ones that make a fold different from the truncation it replaces — above all
 * that every task is still represented by exactly one mark.
 */

const task = (
  id: string,
  title: string,
  status: TaskStatus = TaskStatus.OPEN,
  parentTaskId: string | null = null,
): FoldTask => ({ id, title, status, parentTaskId });

/** One component, `length` long, task i waiting on task i-1. */
function chain(length: number, status: (index: number) => TaskStatus = () => TaskStatus.OPEN) {
  const tasks = Array.from({ length }, (_, i) => task(`t${i}`, `Step ${i + 1}`, status(i)));
  const edges: FoldEdge[] = Array.from({ length: Math.max(length - 1, 0) }, (_, i) => ({
    sourceTaskId: `t${i}`,
    targetTaskId: `t${i + 1}`,
  }));
  return { tasks, edges };
}

/** `instances` copies of one `stages`-step pipeline, the way a batch project is generated. */
function batch(instances: number, stages: string[], status: (instance: number, stage: number) => TaskStatus = () => TaskStatus.OPEN) {
  const tasks: FoldTask[] = [];
  const edges: FoldEdge[] = [];
  for (let i = 0; i < instances; i += 1) {
    stages.forEach((stage, s) => {
      tasks.push(task(`i${i}s${s}`, `[${stage}] shard ${String(i).padStart(5, '0')}`, status(i, s)));
      if (s > 0) edges.push({ sourceTaskId: `i${i}s${s - 1}`, targetTaskId: `i${i}s${s}` });
    });
  }
  return { tasks, edges };
}

/** Tasks represented, counted the way the reader would: one mark can stand for many. */
function representedTaskCount(marks: ProjectGraphMark[]): number {
  return marks.reduce((sum, mark) => sum + (mark.kind === 'TASK' ? 1 : mark.taskCount), 0);
}

test('normalizeTitle takes out the varying part and nothing else', () => {
  assert.equal(
    normalizeTitle('[FineWeb][CC-MAIN-2013-20] 000_00000.parquet'),
    '[FineWeb][CC-MAIN-*] *.parquet',
  );
  assert.equal(normalizeTitle('Step 12'), 'Step *');
  // Two instances of one motif normalize to one thing; two different stages never do.
  assert.notEqual(normalizeTitle('[Merge] 1 → RocksDB'), normalizeTitle('[校验] 1.rocksdb'));
});

test('a project small enough to draw is not folded at all', () => {
  const { tasks, edges } = chain(DEFAULT_FOLD_OPTIONS.expandLimit);

  const fold = foldProjectGraph(tasks, edges);

  assert.equal(fold.folded, false);
  assert.equal(fold.marks.length, tasks.length);
  assert.ok(fold.marks.every((mark) => mark.kind === 'TASK'));
  assert.equal(fold.edges.length, edges.length);
});

test('a long straight run folds, and the work at its head does not', () => {
  const { tasks, edges } = chain(118, (i) => (i < 12 ? TaskStatus.DONE : TaskStatus.OPEN));

  const fold = foldProjectGraph(tasks, edges);

  assert.equal(fold.folded, true);
  // Every task still on the canvas, none dropped — the whole difference from truncating.
  assert.equal(representedTaskCount(fold.marks), 118);
  assert.ok(fold.marks.length <= 6, `118 tasks folded to ${fold.marks.length} marks`);

  const expanded = fold.marks.filter((mark) => mark.kind === 'TASK');
  // The frontier — the first task that is not finished — and what it releases next.
  assert.deepEqual(expanded.map((mark) => mark.id), ['t12', 't13']);
  const runs = fold.marks.filter((mark) => mark.kind === 'RUN');
  assert.equal(runs.length, 2, 'the finished prefix and the untouched tail are separate marks');
  assert.equal(runs[0].taskCount, 12);
  assert.deepEqual(runs[0].statusCounts.DONE, 12);
  assert.equal(runs[0].title, '12 steps · done');
  assert.equal(runs[1].taskCount, 104);
  // The marks are still a chain: prefix → frontier → next → tail.
  assert.equal(fold.edges.length, 3);
});

test('running and failed work is never folded away', () => {
  const { tasks, edges } = chain(100, (i) => {
    if (i < 40) return TaskStatus.DONE;
    if (i === 40) return TaskStatus.IN_PROGRESS;
    if (i === 70) return TaskStatus.FAILED;
    return TaskStatus.OPEN;
  });

  const fold = foldProjectGraph(tasks, edges);
  const expanded = new Set(fold.marks.filter((mark) => mark.kind === 'TASK').map((mark) => mark.id));

  assert.ok(expanded.has('t40'), 'the running task is its own mark');
  assert.ok(expanded.has('t70'), 'the failed task is its own mark wherever it sits');
  assert.equal(representedTaskCount(fold.marks), 100);
});

test('a run never crosses a parent boundary, so boxes still hold their own members', () => {
  const tasks = [
    task('boxA', 'Toolchain'),
    task('boxB', 'User space'),
    ...Array.from({ length: 40 }, (_, i) => task(`a${i}`, `A step ${i}`, TaskStatus.DONE, 'boxA')),
    ...Array.from({ length: 40 }, (_, i) => task(`b${i}`, `B step ${i}`, TaskStatus.DONE, 'boxB')),
  ];
  const edges: FoldEdge[] = [
    ...Array.from({ length: 39 }, (_, i) => ({ sourceTaskId: `a${i}`, targetTaskId: `a${i + 1}` })),
    { sourceTaskId: 'a39', targetTaskId: 'b0' },
    ...Array.from({ length: 39 }, (_, i) => ({ sourceTaskId: `b${i}`, targetTaskId: `b${i + 1}` })),
  ];

  const fold = foldProjectGraph(tasks, edges);
  const runs = fold.marks.filter((mark) => mark.kind === 'RUN');

  assert.equal(representedTaskCount(fold.marks), tasks.length);
  assert.ok(runs.length >= 2, 'one run per box, not one run spanning both');
  for (const run of runs) {
    const parents = new Set(run.members.map((member) => member.taskId[0] === 'a' ? 'boxA' : 'boxB'));
    assert.equal(parents.size, 1);
    assert.equal(run.parentTaskId, [...parents][0]);
  }
});

test('a motif instantiated many times folds to one copy carrying the count', () => {
  const stages = ['FineWeb', 'WARC', 'Merge', '校验'];
  const { tasks, edges } = batch(200, stages);

  const fold = foldProjectGraph(tasks, edges);

  assert.equal(fold.marks.length, 4, '800 tasks, one four-step motif');
  assert.equal(representedTaskCount(fold.marks), 800);
  const motifs = fold.marks.filter((mark) => mark.kind === 'MOTIF');
  assert.equal(motifs.length, 4);
  for (const [index, motif] of motifs.entries()) {
    assert.equal(motif.instanceCount, 200);
    assert.equal(motif.taskCount, 200);
    assert.ok(motif.title.includes(stages[index]), `${motif.title} is stage ${stages[index]}`);
    assert.equal(motif.title.includes('00000'), false, 'the varying part is normalized away');
  }
  // The motif is drawn as the pipeline it is: four stages, three arrows.
  assert.equal(fold.edges.length, 3);
});

test('a motif mark hands back the instances that broke, not an arbitrary six', () => {
  const { tasks, edges } = batch(100, ['FineWeb', 'Merge'], (instance, stage) => {
    if (stage === 1 && instance % 25 === 0) return TaskStatus.FAILED;
    if (stage === 1 && instance === 3) return TaskStatus.IN_PROGRESS;
    return TaskStatus.DONE;
  });

  const fold = foldProjectGraph(tasks, edges);
  const merge = fold.marks.find((mark) => mark.kind === 'MOTIF' && mark.title.includes('Merge'));

  assert.ok(merge && merge.kind === 'MOTIF');
  assert.equal(merge.statusCounts.FAILED, 4);
  assert.equal(merge.statusCounts.IN_PROGRESS, 1);
  assert.ok(merge.samples.length <= DEFAULT_FOLD_OPTIONS.maxMotifSamples);
  assert.deepEqual(
    merge.samples.slice(0, 4).map((sample) => sample.status),
    [TaskStatus.FAILED, TaskStatus.FAILED, TaskStatus.FAILED, TaskStatus.FAILED],
    'failures come first',
  );
  assert.equal(merge.samples[4].status, TaskStatus.IN_PROGRESS);
});

test('components that repeat too few times to be a motif keep their own tasks', () => {
  const { tasks, edges } = batch(2, ['A', 'B']);
  const filler = chain(70);

  const fold = foldProjectGraph(
    [...tasks, ...filler.tasks],
    [...edges, ...filler.edges],
  );

  assert.equal(fold.marks.some((mark) => mark.kind === 'MOTIF'), false);
  assert.equal(representedTaskCount(fold.marks), tasks.length + filler.tasks.length);
});

/** `0 -> 'a'`, `26 -> 'ba'`: a title that differs from every other in letters, not digits. */
function letters(index: number): string {
  let word = '';
  for (let left = index; ; left = Math.floor(left / 26) - 1) {
    word = String.fromCharCode(97 + (left % 26)) + word;
    if (left < 26) return word;
  }
}

test('a fold too big for one response says so instead of quietly ending early', () => {
  // 600 tasks that share nothing: no edges to run-fold, and titles that differ in letters rather
  // than digits, so normalization never groups them into a motif either. Every task stays its own
  // mark and the mark budget is what bites.
  const tasks: FoldTask[] = [];
  const edges: FoldEdge[] = [];
  for (let i = 0; i < 300; i += 1) {
    tasks.push(task(`x${i}`, `Alpha ${letters(i)}`));
    tasks.push(task(`y${i}`, `Beta ${letters(i)}`));
  }

  const fold = foldProjectGraph(tasks, edges, { ...DEFAULT_FOLD_OPTIONS, maxMarks: 100 });

  assert.equal(fold.truncated, true);
  assert.equal(fold.marks.length, 100);
});

test('an edge naming a task the fold never saw is dropped, not drawn to nothing', () => {
  const { tasks, edges } = chain(80);

  const fold = foldProjectGraph(tasks, [...edges, { sourceTaskId: 't0', targetTaskId: 'elsewhere' }]);

  assert.ok(fold.edges.every((edge) => edge.targetMarkId !== 'elsewhere'));
});
