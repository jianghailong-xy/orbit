import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { WIKI_REVIEW_RULES, type WikiVerificationItem } from '@orbit/shared';
import { quoted, unwrapped } from '../wiki/wiki-plan';
import { describeWikiVerdictOutcome } from './wiki-verify-job';
import {
  WIKI_VERIFY_SYSTEM_PROMPT,
  WIKI_VERIFY_VERDICTS,
  lastJSONObject,
  parseWikiVerdict,
  wikiVerifyCandidates,
  wikiVerifyNumbers,
  wikiVerifyPrompt,
  wikiVerifyRetrySuffix,
} from './wiki-verify';

/**
 * The model part of the verification, ported from `src/runner-go/wiki_verify_test.go`: the prompt one op is
 * asked about, the numbers a duplicate may name, the answer read as strictly as the runner reads it, and the
 * second asking a maintenance run makes. What the port changes is where the answer comes from — the System
 * model through the request queue, not a clean Claude Code — and that is `wiki-verify-job.pg.spec.ts`'s.
 *
 * The cases are the Go ones, byte for byte where they can be: a phrase a refusal says back is what the second
 * asking carries into the prompt, so the two paths must refuse in the same words.
 */

// The shared contract, as the Go test reads it: what the prompt must say, and the four verdicts.
const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8')) as {
  agentSurface: { verify: { prompt: string; unreadable: string; precondition: string; cli: string } };
  reviewModes: { verification: { verdicts: Record<string, string> } };
};

const REBASE = { id: '34XhYj76NhjjOJTEFEtFE', kind: 'convention' as const, title: '收工前 rebase 到 main、写明分支和 sha、不自己 merge', status: 'active' as const, trust: 'auto' as const, score: 1 };
const OTHER = { id: '34XhYj76NhjjOJTEFEtFA', kind: 'convention' as const, title: 'Closed sets are CHECK constraints', status: 'active' as const, trust: 'auto' as const, score: 1 };
const CLOSED = { id: 'entry-closed-sets', kind: 'convention' as const, title: 'Closed sets', status: 'active' as const, trust: 'auto' as const, score: 1 };

/** One op of the list, citing one record, with the neighbours given: the Go test's `verifyItem`, per op. */
function verifyItem(title: string, similar: WikiVerificationItem['similar'] = []): WikiVerificationItem {
  return {
    opId: `op-${title.toLowerCase().replace(/\W+/gu, '-')}`,
    changesetId: 'cs-1',
    op: 'add',
    entryId: null,
    entry: {
      kind: 'pitfall',
      title,
      summary: `What ${title.toLowerCase()} means.`,
      fields: { symptom: 'It went wrong.', fix: 'Do the other thing.' },
      topics: [],
      aliases: [],
    },
    sources: [{
      kind: 'tool_call',
      ref: `tc-${title.toLowerCase().replace(/\W+/gu, '-')}`,
      quote: 'it went wrong',
      text: `The build said: it went wrong, and ${title} was the reason.`,
      truncated: false,
    }],
    evidence: 'readable',
    similar,
  };
}

test('the four verdicts are the contract\'s, and the prompt offers exactly those', () => {
  assert.deepEqual([...WIKI_VERIFY_VERDICTS], Object.keys(CONTRACT.reviewModes.verification.verdicts));
  const prompt = wikiVerifyPrompt(verifyItem('An entry'), []);
  for (const verdict of WIKI_VERIFY_VERDICTS) assert.ok(prompt.includes(`"${verdict}"`), `the prompt never offers ${verdict}`);
  assert.match(WIKI_VERIFY_SYSTEM_PROMPT, /^You verify proposed wiki entries against the records they cite\./u);
  // The contract the runner ships next says the same about numbers, and this side keeps to it.
  assert.match(CONTRACT.agentSurface.verify.prompt, /each by a number of its own, E1 to En in the order listed, and never by its id/u);
  assert.match(CONTRACT.agentSurface.verify.unreadable, /A number is one the prompt listed, exactly: an id, whole or cut short, is none, and nothing is guessed from a prefix/u);
});

test('parses only a verdict', () => {
  const candidates = wikiVerifyCandidates({
    op: 'add', entryId: null, entry: { kind: 'pitfall', title: 'An entry' },
    similar: [{ id: '34XhYj76NhjjOJTEFEtFE', kind: 'pitfall', title: 'An entry', status: 'active', trust: 'auto', score: 1 }],
  });
  assert.deepEqual(wikiVerifyNumbers(candidates), ['E1']);
  const cases: Array<{ text: string; verdict?: string; refuse?: string }> = [
    { text: '{"verdict":"supported","reason":"Yes."}', verdict: 'supported' },
    { text: 'Thinking it over: {not json}.\n{"verdict":"partial","reason":"Half."}', verdict: 'partial' },
    { text: '```json\n{"verdict": "unsupported", "reason": "No.", "duplicateOf": ""}\n```', verdict: 'unsupported' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"E1"}', verdict: 'duplicate' },
    // Wrapped as a model wraps a closed-set value: only the wrapping goes.
    { text: '{"verdict":"`duplicate`","reason":"Same.","duplicateOf":" `E1` "}', verdict: 'duplicate' },
    { text: 'Supported.', refuse: 'no JSON object' },
    { text: '{"verdict":"Supported ","reason":"Yes."}', refuse: 'verdict is not one of' },
    { text: '{"verdict":"supported","reason":"   "}', refuse: 'no reason' },
    { text: '{"verdict":"duplicate","reason":"Same."}', refuse: 'must name one of the listed entries' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"E2"}', refuse: 'must name one of the listed entries by its number (E1), and "E2" is not one' },
    // A number is one of the listed ones exactly: not its id, whole or cut short, and nothing like it.
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"34XhYj76NhjjOJTEFEtFE"}', refuse: 'and "34XhYj76NhjjOJTEFEtFE" is not one' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"34XhYj76NhjjOJTEFE"}', refuse: 'and "34XhYj76NhjjOJTEFE" is not one' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"e1"}', refuse: 'and "e1" is not one' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"E01"}', refuse: 'and "E01" is not one' },
    { text: '{"verdict":"duplicate","reason":"Same.","duplicateOf":"E1 (An entry)"}', refuse: 'and "E1 (An entry)" is not one' },
    { text: '{"verdict":"partial","reason":"Half.","duplicateOf":"E1"}', refuse: 'a partial verdict names a duplicate ("E1"), which only a duplicate does' },
    { text: '{"reason":"No verdict here."}', refuse: 'no JSON object' },
  ];
  for (const one of cases) {
    const got = parseWikiVerdict(one.text, candidates);
    if (one.refuse !== undefined) {
      assert.ok('refusal' in got && got.refusal.includes(one.refuse), `${one.text} = ${JSON.stringify(got)}, want refused for ${one.refuse}`);
      continue;
    }
    assert.ok('verdict' in got, `${one.text} = ${JSON.stringify(got)}, want ${one.verdict}`);
    assert.equal(got.verdict.verdict, one.verdict);
    if (one.verdict === 'duplicate') assert.equal(got.verdict.duplicateOf, '34XhYj76NhjjOJTEFEtFE', 'the id of the entry its number names');
  }
  // Nothing is listed: a duplicate has nothing to name, and says so.
  const none = parseWikiVerdict('{"verdict":"duplicate","reason":"Same.","duplicateOf":"E1"}', []);
  assert.ok('refusal' in none && none.refusal.includes('by its number, and none is listed (it named "E1")'));
  // A reason is cut to what the server keeps, in characters, not bytes.
  const long = parseWikiVerdict(`{"verdict":"supported","reason":"${'é'.repeat(600)}"}`, []);
  assert.ok('verdict' in long && [...long.verdict.reason].length === WIKI_REVIEW_RULES.verificationReasonMaxChars);
});

test('reports nothing for an answer that is not a verdict', () => {
  // The five shapes of 09-30 to 10-02, each one an op that keeps waiting: prose, another verdict, a duplicate
  // naming an entry nobody listed, no reason at all, and a verdict naming a duplicate it is not.
  const neighbour = [{ ...CLOSED }];
  const unreadable: Array<[string, WikiVerificationItem['similar']]> = [
    ['I think the records support it, mostly.', []],
    ['{"verdict": "maybe", "reason": "Hard to say."}', []],
    ['{"verdict": "duplicate", "reason": "Seen it.", "duplicateOf": "entry-nobody-listed"}', neighbour],
    ['{"verdict": "supported"}', []],
    ['{"verdict": "supported", "reason": "Fine.", "duplicateOf": "entry-closed-sets"}', neighbour],
  ];
  for (const [answer, similar] of unreadable) {
    const got = parseWikiVerdict(answer, wikiVerifyCandidates(verifyItem('A claim', similar)));
    assert.ok('refusal' in got, `${answer} was read as a verdict`);
    assert.ok(got.refusal.length > 0, 'a refusal says why');
  }
});

test('asks again saying why the last answer was not taken', () => {
  const refused = 'a duplicate must name one of the listed entries by its number (E1, E2), and "entry-gone" is not one';
  const listed = wikiVerifyCandidates({
    op: 'add', entryId: null, entry: { kind: 'pitfall', title: 'An entry' },
    similar: [
      { id: 'entry-a', kind: 'pitfall', title: 'A', status: 'active', trust: 'auto', score: 1 },
      { id: 'entry-b', kind: 'convention', title: 'B', status: 'active', trust: 'auto', score: 1 },
    ],
  });
  const again = wikiVerifyRetrySuffix(refused, listed);
  for (const part of [
    '## Your last answer was not taken',
    `your answer was not a verdict: ${refused}.`,
    'duplicateOf must be one of these numbers of the entries listed above: E1, E2.',
    'Answer again, with one JSON object and nothing else.',
  ]) {
    assert.ok(again.includes(part), `the second asking does not say ${JSON.stringify(part)}:\n${again}`);
  }
  const none = wikiVerifyRetrySuffix('no JSON object in it', []);
  assert.ok(none.includes('your answer was not a verdict: no JSON object in it.'));
  assert.ok(none.includes('No entry is listed above, so this entry is no duplicate: answer supported, partial or unsupported'));
  assert.ok(!again.includes('entry-a') && !again.includes('entry-b'), 'the second asking names an entry by its id');
  // However it was asked, an answer naming an entry not listed, or one by its id, is still no verdict.
  for (const named of ['entry-gone', 'E3', 'entry-a']) {
    const got = parseWikiVerdict(`{"verdict":"duplicate","reason":"Same.","duplicateOf":"${named}"}`, listed);
    assert.ok('refusal' in got, `a duplicate of ${named} was read as a verdict`);
  }
});

test('has the model name a duplicate by its number, never by its id', () => {
  const item = verifyItem('Numbered claim', [OTHER, REBASE]);
  const candidates = wikiVerifyCandidates(item);
  assert.deepEqual(candidates.map((one) => [one.number, one.id]), [['E1', OTHER.id], ['E2', REBASE.id]]);
  const prompt = wikiVerifyPrompt(item, candidates);
  for (const part of [
    '- E1: [convention] Closed sets are CHECK constraints\n',
    '- E2: [convention] 收工前 rebase 到 main、写明分支和 sha、不自己 merge\n',
  ]) {
    assert.ok(prompt.includes(part), `the prompt does not list ${JSON.stringify(part)}:\n${prompt}`);
  }
  assert.ok(!prompt.includes('34XhYj76'), 'the prompt shows the model an id to copy');
  // The number is mapped to the id it stands for; anything else is no verdict, and nothing is reported for it.
  const mapped = parseWikiVerdict('{"verdict": "duplicate", "reason": "It says what that convention says.", "duplicateOf": "E2"}', candidates);
  assert.ok('verdict' in mapped && mapped.verdict.duplicateOf === REBASE.id);
  for (const [number, value] of [['34XhYj76NhjjOJTEFE', '"34XhYj76NhjjOJTEFE"'], ['34XhYj76NhjjOJTEFEtFE', '"34XhYj76NhjjOJTEFEtFE"'], ['E3', '"E3"']]) {
    const got = parseWikiVerdict(`{"verdict": "duplicate", "reason": "It says what that convention says.", "duplicateOf": "${number}"}`, candidates);
    assert.ok('refusal' in got && got.refusal === `a duplicate must name one of the listed entries by its number (E1, E2), and ${value} is not one`,
      `${number} was refused for ${JSON.stringify(got)}`);
  }
});

test('offers the model only live neighbours and the amends own entry', () => {
  const item: WikiVerificationItem = {
    opId: 'op-a',
    changesetId: 'cs-1',
    op: 'amend',
    entryId: 'entry-self',
    entry: { kind: 'pitfall', title: 'An amended pitfall', summary: 'Now sharper.', fields: { fix: 'x' }, topics: [], aliases: [] },
    sources: [
      { kind: 'commit', ref: 'abc123', quote: null, text: null, truncated: false },
      { kind: 'tool_call', ref: 'tc', quote: 'q', text: 'long', truncated: true },
    ],
    evidence: 'readable',
    similar: [
      { id: 'entry-live', kind: 'pitfall', title: 'Live', status: 'active', trust: 'auto', score: 1 },
      { id: 'entry-proposed', kind: 'pitfall', title: 'Waiting', status: 'proposed', trust: 'auto', score: 1 },
      { id: 'entry-self', kind: 'pitfall', title: 'Itself', status: 'active', trust: 'auto', score: 1 },
    ],
  };
  const candidates = wikiVerifyCandidates(item);
  assert.deepEqual(candidates.map((one) => one.id), ['entry-self', 'entry-live']);
  assert.deepEqual(wikiVerifyNumbers(candidates), ['E1', 'E2']);
  const prompt = wikiVerifyPrompt(item, candidates);
  for (const part of [
    'the change amends entry E1, listed below',
    '- E1: [pitfall] An amended pitfall (the entry this amend changes)',
    '- E2: [pitfall] Live',
    '### Record 1: commit abc123',
    "This record's text is not available",
    '(The text was cut here.)',
    '"fix": "x"',
  ]) {
    assert.ok(prompt.includes(part), `the prompt does not carry ${JSON.stringify(part)}:\n${prompt}`);
  }
  for (const id of ['entry-self', 'entry-live', 'entry-proposed']) {
    assert.ok(!prompt.includes(id), `the prompt names ${id} by its id:\n${prompt}`);
  }
});

test('lastJSONObject is the last object that carries a verdict, fences and thinking aloud included', () => {
  const only = '{"verdict":"supported","reason":"Yes."}';
  assert.equal(lastJSONObject(only), only);
  assert.equal(lastJSONObject(`Thinking it over, {not: json}.\n\`\`\`json\n${only}\n\`\`\``), only);
  assert.equal(lastJSONObject('{"a":1}'), null, 'an object without a verdict is none');
  assert.equal(lastJSONObject('no object at all'), null);
  const second = '{"verdict":"partial","reason":"Half."}';
  assert.equal(lastJSONObject(`${only}\nand again: ${second}`), second);
});

test('quotes what a value holds and unwraps only its wrapping', () => {
  // The plan gate's reader and writer, which this side reads closed-set values with (`plan.gate.values`).
  for (const [value, want] of Object.entries({
    decision: '"decision"',
    '`decision`': '"`decision`"',
    ' decision ': '" decision "',
    'decision​': '"decision\\u200b"',
    '﻿decision': '"\\ufeffdecision"',
    'a b　c': '"a\\u00a0b\\u3000c"',
    'say "hi"\\': '"say \\"hi\\"\\\\"',
    'tab\there\n': '"tab\\there\\n"',
    '\x00\x7f\u0085': '"\\u0000\\u007f\\u0085"',
    '决策 «x»': '"决策 «x»"',
    '\u{e0001}': '"\\udb40\\udc01"',
  })) {
    assert.equal(quoted(value), want);
    assert.equal(JSON.parse(quoted(value)), value, 'it is JSON that reads back as the value');
  }
  for (const [value, want] of Object.entries({
    decision: 'decision',
    '`decision`': 'decision',
    ' `decision` ': 'decision',
    '"decision"': 'decision',
    "'decision'": 'decision',
    '“decision”': 'decision',
    '「decision」': 'decision',
    '« `decision` »': 'decision',
    '`E2`': 'E2',
    '`decision': '`decision',
    'dec`ision': 'dec`ision',
    '`decision"': '`decision"',
    decisions: 'decisions',
    Decision: 'Decision',
    'decision​': 'decision​',
    '``': '',
    '`': '`',
    '"pitfall" `x`': '"pitfall" `x`',
    '`a` and `b`': '`a` and `b`',
    '34XhYj76NhjjOJTEFE': '34XhYj76NhjjOJTEFE',
  })) {
    assert.equal(unwrapped(value), want);
  }
});

test('says which live entry an adopted op turned out to duplicate', () => {
  const twin = describeWikiVerdictOutcome(
    { status: 'reinforced', entryId: 'entry-later', reinforced: true },
    { verdict: 'supported', reason: 'The record says so.', duplicateOf: null },
  );
  assert.equal(twin, 'a duplicate of the live entry entry-later, which holds its very content: its sources were added there');
  const held = describeWikiVerdictOutcome(
    { status: 'reinforced', entryId: 'entry-later', reinforced: false },
    { verdict: 'partial', reason: 'Some of it.', duplicateOf: null },
  );
  assert.ok(held.startsWith('a duplicate of the live entry entry-later'));
  assert.ok(held.includes('its sources were not added'));
  const named = describeWikiVerdictOutcome(
    { status: 'reinforced', entryId: 'entry-named', reinforced: true },
    { verdict: 'duplicate', reason: 'Said already.', duplicateOf: 'entry-named' },
  );
  assert.equal(named, 'a duplicate of entry-named: its sources were added there');
  assert.equal(
    describeWikiVerdictOutcome({ status: 'applied', trust: 'auto', spotCheck: true }, { verdict: 'supported', reason: 'Yes.', duplicateOf: null }),
    'applied as Auto, and pushed; drawn as a spot check for the owner',
  );
  assert.equal(
    describeWikiVerdictOutcome({ status: 'rejected' }, { verdict: 'unsupported', reason: 'Nothing mentions tmpfs.', duplicateOf: null }),
    'rejected: Nothing mentions tmpfs.',
  );
});
