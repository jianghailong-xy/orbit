import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_DOC_DIAGRAM_RULES } from '@orbit/shared';

import { parseDiagram } from './wiki-doc-diagram';
import { diagramWord, keepSourcedDiagrams, parseSectionBody } from './wiki-docs';

/**
 * A section's diagram (contract `docs.diagram`): the flowchart the server reads out of a mermaid block and writes out
 * again, what is no diagram, and the check that keeps one only as far as the section's sourced sentences go.
 */

test('a flowchart is written out again in one spelling: its own ids, every label quoted, its shapes, links and subgraphs', () => {
  const diagram = parseDiagram([
    'graph LR',
    '%%{init: {"theme": "forest"}}%%',
    '  %% the claim',
    '  plan[Plan confirmed] --> job(["`docs_build` job [D1]"])',
    '  job -->|claims| worker[(wiki-worker)]:::store',
    '  worker -- reads --> repo{{Repository}};',
    '  worker -.-> queue{Model queue}',
    '  subgraph server["The server"]',
    '    direction TB',
    '    queue ==> model((System model))',
    '  end',
    '  style worker fill:#f9f',
    '  click worker "https://example.com"',
    '  model --- plan',
  ].join('\n'));
  assert.ok(diagram);
  assert.equal(diagram.source, [
    'flowchart LR',
    '  n1["Plan confirmed"]',
    '  n2(["docs_build job"])',
    '  n3[("wiki-worker")]',
    '  n4{{"Repository"}}',
    '  n5{"Model queue"}',
    '  subgraph s1["The server"]',
    '    direction TB',
    '    n6(("System model"))',
    '  end',
    '  n1 --> n2',
    '  n2 -->|"claims"| n3',
    '  n3 -->|"reads"| n4',
    '  n3 -.-> n5',
    '  n5 ==> n6',
    '  n6 --- n1',
  ].join('\n'), 'no config directive, style or click is carried, and a node keeps the subgraph it first appeared in');
  assert.deepEqual(diagram.labels, ['Plan confirmed', 'docs_build job', 'wiki-worker', 'Repository', 'Model queue', 'The server', 'System model', 'claims', 'reads']);
});

test('a label is shown as text: Mermaid\'s characters as entity codes, line breaks as spaces, an id where it has none', () => {
  const diagram = parseDiagram([
    'flowchart TB',
    '  subgraph api[API]',
    '    a[Map<string> & C# "quoted"]',
    '  end',
    '  b["first<br/>second"] --> api',
    '  end_node --> a',
  ].join('\n'));
  assert.ok(diagram);
  assert.equal(diagram.source, [
    'flowchart TB',
    '  subgraph s1["API"]',
    '    n1["Map#lt;string#gt; #amp; C#35; #quot;quoted#quot;"]',
    '  end',
    '  n2["first second"]',
    '  n4["end_node"]',
    '  n2 --> s1',
    '  n4 --> n1',
  ].join('\n'), 'a link to a subgraph\'s id ends at the subgraph');
  assert.deepEqual(diagram.labels, ['API', 'Map<string> & C# "quoted"', 'first second', 'end_node']);
});

test('what is not that flowchart, or is past the rules\' sizes, is no diagram', () => {
  const chain = (n: number) => `flowchart LR\n  ${Array.from({ length: n }, (_, i) => `x${i}`).join(' --> ')}`;
  const cases: Array<[string, string]> = [
    ['sequenceDiagram\n  A->>B: hello', 'another kind of diagram'],
    ['flowchart LR\n  A & B --> C', 'a list joined with &'],
    ['flowchart LR\n  subgraph x\n  A --> B', 'a subgraph never closed'],
    ['flowchart LR\n  A --> B\nend', 'an end with no subgraph'],
    ['flowchart LR\n  A -- B', 'a link that is only its opening'],
    ['flowchart LR\n  A <-- B', 'a head at the start alone'],
    ['flowchart XY\n  A --> B', 'no direction Mermaid has'],
    ['flowchart LR\n  click A "https://example.com"', 'no node at all'],
    ['flowchart LR\n  A["open --> B', 'a quote never closed'],
    [chain(WIKI_DOC_DIAGRAM_RULES.nodesMax + 1), 'more nodes than nodesMax'],
    [`flowchart LR\n  A["${'x'.repeat(WIKI_DOC_DIAGRAM_RULES.labelMaxChars + 1)}"]`, 'a label past labelMaxChars'],
  ];
  for (const [text, what] of cases) assert.equal(parseDiagram(text), null, what);
  assert.ok(parseDiagram(chain(WIKI_DOC_DIAGRAM_RULES.nodesMax)), 'nodesMax nodes are a diagram');
});

test('a mermaid block of a section is a diagram block, or nothing; any other fence stays code', () => {
  const body = parseSectionBody([
    '### Delivery',
    'A turn is stored before it is delivered[1].',
    '',
    '```mermaid',
    'flowchart LR',
    '  turn["Turn stored"] --> delivered["Delivered"]',
    '```',
    '',
    'The runner polls[2].',
    '',
    '``` Mermaid',
    'sequenceDiagram',
    '```',
    '',
    '```js',
    'claim()',
    '```',
  ].join('\n'), 2);
  assert.deepEqual(body.blocks, [
    { kind: 'paragraph' },
    { kind: 'diagram', text: 'flowchart LR\n  n1["Turn stored"]\n  n2["Delivered"]\n  n1 --> n2' },
    { kind: 'paragraph' },
    { kind: 'code', text: 'claim()' },
  ]);
  assert.deepEqual(body.diagrams, [{ block: 1, labels: ['Turn stored', 'Delivered'] }]);
  assert.equal(body.diagramsDropped, 1, 'the sequence diagram is no diagram, and no code either');
  assert.deepEqual(body.sentences.map((sentence) => [sentence.block, sentence.notes]), [[0, [0]], [2, [1]]]);
});

test('a diagram is kept when its every word is one a sentence with a verified footnote says; otherwise it goes, and the blocks after it move up', () => {
  const markdown = [
    'A turn is stored before it is delivered[1].',
    '',
    '```mermaid',
    'flowchart LR',
    '  turn["Turn stored"] --> delivered["Delivered"]',
    '```',
    '',
    'The runner polls[2].',
  ].join('\n');
  const body = parseSectionBody(markdown, 2);
  assert.equal(keepSourcedDiagrams(body, [true, true]), body, 'every word is sourced: the body stands as it is');
  // The only sentence that says "turn", "stored" and "delivered" has no verified footnote.
  const dropped = keepSourcedDiagrams(body, [false, true]);
  assert.deepEqual(dropped.blocks, [{ kind: 'paragraph' }, { kind: 'paragraph' }]);
  assert.deepEqual(dropped.sentences.map((sentence) => [sentence.text, sentence.block]), [['A turn is stored before it is delivered.', 0], ['The runner polls.', 1]]);
  assert.deepEqual([dropped.diagrams, dropped.diagramsDropped], [[], 1]);
});

test('a flowchart\'s own words need no source, and a section keeps one diagram', () => {
  const body = parseSectionBody([
    'The runner polls[1].',
    '',
    '```mermaid',
    'flowchart TB',
    '  s([Start]) --> r[runner] -->|yes| p[polls] --> e([End])',
    '```',
    '',
    '```mermaid',
    'flowchart TB',
    '  r[runner]',
    '```',
  ].join('\n'), 1);
  const kept = keepSourcedDiagrams(body, [true]);
  assert.deepEqual(kept.blocks.map((block) => block.kind), ['paragraph', 'diagram']);
  assert.deepEqual([kept.diagrams.length, kept.diagramsDropped], [1, 1], 'the second one is one too many');
  assert.match(kept.blocks[1].text ?? '', /"Start"[\s\S]*\|"yes"\|/u);
});

test('a word is the same word with another ending; a code name, a path or a number is only itself', () => {
  for (const words of [['store', 'stored', 'stores', 'storing'], ['deliver', 'delivered', 'delivers'], ['retry', 'retries', 'retried'], ['lease', 'leases', 'leased'], ['process', 'processes']]) {
    assert.equal(new Set(words.map(diagramWord)).size, 1, words.join(', '));
  }
  for (const token of ['docs_build', 'scheduler.claim', 'src/runloop.go', '60', 'claimtask']) assert.equal(diagramWord(token), token);
  assert.notEqual(diagramWord('claim'), diagramWord('claimtask'));
  // Kept: "stores", "delivers" and "retried" stand for the labels' "store", "deliver" and "retries".
  const body = parseSectionBody([
    'The server stores a turn before it delivers it[1]. A lost delivery is retried[1].',
    '',
    '```mermaid',
    'flowchart LR',
    '  s[Store turn] --> d[Deliver] -->|lost| r[Retries]',
    '```',
  ].join('\n'), 1);
  assert.equal(keepSourcedDiagrams(body, [true]).diagrams.length, 1);
  // Dropped: no sourced sentence says "cache", in any form.
  const more = parseSectionBody([
    'The server stores a turn before it delivers it[1].',
    '',
    '```mermaid',
    'flowchart LR',
    '  s[Store turn] --> c[Cache] --> d[Deliver]',
    '```',
  ].join('\n'), 1);
  assert.equal(keepSourcedDiagrams(more, [true]).diagramsDropped, 1);
});
