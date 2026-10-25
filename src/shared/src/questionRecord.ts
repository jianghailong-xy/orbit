/**
 * How an agent's question (`AskUserQuestion`) ended, read back from the one record of it a client
 * is given: the result text the engine wrote for the agent.
 *
 * The answer is not kept anywhere a client reads. Orbit hands it to the engine as
 * `updatedInput.answers` (question text → labels, the runner's `askQuestionInput`), and claude
 * writes the tool's result from it:
 *
 *   The user answered: "<question>"="<answer>", "<question>"="<answer>". Read the answers carefully …
 *   Your questions have been answered: "<question>"="<answer>". You can now continue with …
 *
 * A multi-select answer is its labels joined by a bare comma, with any words typed beside them
 * last. "Chat about this" answers the question as a refusal whose message is the person's own
 * words, so that result is an error and its whole text is the reply.
 *
 * Both clients draw the answered card from this reading — the web from here, the native client
 * from OrbitKit's `QuestionRecords` — and `question-record.fixture.json` is the set of cases both
 * are proved against.
 */

/** One question of an AskUserQuestion call, as the call's input carries it. */
export interface AskedQuestion {
  question: string;
  header: string | null;
  options: { label: string; description: string | null }[];
  multiSelect: boolean;
}

/** One question's answer: the options picked, by their index in the order offered, and the words
 *  typed instead of (or, on a multi-select question, beside) a listed option. */
export interface QuestionAnswer {
  picked: number[];
  typed: string | null;
}

/**
 * How the question ended. `answered` carries one entry per question, null where the result names
 * none. Null as a whole when the result says neither — no result yet, a failure, or a wording this
 * reader does not know — and the card then shows the result as it was written.
 */
export type QuestionOutcome =
  | { kind: 'answered'; answers: (QuestionAnswer | null)[] }
  | { kind: 'replied'; words: string };

export const QUESTION_RECORD_COPY = {
  /** Under a reply given in the conversation instead of a pick, and over it once the card opens. */
  repliedInChat: 'Replied in chat',
  /** Over the words typed instead of a listed option, once the card opens. */
  yourAnswer: 'Your answer',
  /** Beside a question that took several picks: the words the question card itself uses. */
  multipleChoice: 'Multiple choice',
} as const;

/** Error results that are the call failing rather than a person replying. */
const FAILURE_PREFIXES = ['<tool_use_error>', 'approval poll failed'];
/** The runner's refusal when no words came with it: nobody said anything. */
const BARE_DENIAL = 'denied by the user';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const optionalText = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The questions an AskUserQuestion call asked, read off its input. */
export function askedQuestions(input: unknown): AskedQuestion[] {
  const raw = input && typeof input === 'object' ? (input as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const item = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
    const options = Array.isArray(item.options) ? item.options : [];
    return {
      question: text(item.question),
      header: optionalText(item.header),
      options: options.map((o) => {
        const option = o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
        return { label: text(option.label), description: optionalText(option.description) };
      }),
      multiSelect: item.multiSelect === true,
    };
  });
}

/** A question's opening, for the folded card: one line of text, however the agent broke it. */
export function questionLead(question: string): string {
  return question.replace(/\s+/g, ' ').trim();
}

/** The folded card's answer line: the picked options' labels, then any typed words in quotes,
 *  joined by " · ". Null when the result names no answer to this question. */
export function questionAnswerLine(question: AskedQuestion, answer: QuestionAnswer | null): string | null {
  if (!answer) return null;
  const parts = answer.picked.map((i) => question.options[i]?.label ?? '').filter((label) => label !== '');
  if (answer.typed) parts.push(`“${answer.typed}”`);
  return parts.length ? parts.join(' · ') : null;
}

/** A reply given in the conversation instead of a pick, as the folded card quotes it. */
export function questionReplyLine(words: string): string {
  return `“${words}”`;
}

/** Read how the questions ended from the call's result. */
export function questionOutcome(
  questions: AskedQuestion[],
  result: string | null | undefined,
  isError: boolean,
): QuestionOutcome | null {
  const written = (result ?? '').trim();
  if (written === '') return null;
  if (isError) {
    if (written === BARE_DENIAL || FAILURE_PREFIXES.some((prefix) => written.startsWith(prefix))) return null;
    return { kind: 'replied', words: written };
  }
  // Where each answer starts — right after `"<question>"="` — and where its pair does.
  const found = questions.map((q) => {
    if (q.question === '') return null;
    const marker = `"${q.question}"="`;
    const at = written.indexOf(marker);
    return at < 0 ? null : { pair: at, start: at + marker.length };
  });
  const answers = questions.map((q, i): QuestionAnswer | null => {
    const here = found[i];
    if (!here) return null;
    // An answer runs to the next pair, or to the end; its closing quote is the last one before
    // that. The sentence after the last pair holds none, and neither does `, ` between pairs.
    const next = found
      .filter((f): f is { pair: number; start: number } => !!f && f.pair > here.start)
      .reduce((end, f) => Math.min(end, f.pair), written.length);
    const close = written.lastIndexOf('"', next - 1);
    if (close < here.start) return null;
    return readAnswer(q, written.slice(here.start, close));
  });
  return answers.some((a) => a !== null) ? { kind: 'answered', answers } : null;
}

/** One answer's words as the picks they name and the words left over. */
function readAnswer(q: AskedQuestion, words: string): QuestionAnswer | null {
  if (words === '') return null;
  const labels = q.options.map((o) => o.label);
  if (!q.multiSelect) {
    // One option, or the person's own words — the question card keeps the two apart.
    const at = labels.indexOf(words);
    return at >= 0 ? { picked: [at], typed: null } : { picked: [], typed: words };
  }
  // Labels joined by commas, typed words last. A label may hold a comma itself, so each step takes
  // the longest label the rest starts with that ends where a comma or the answer does.
  const picked: number[] = [];
  let rest = words;
  for (;;) {
    let best = -1;
    labels.forEach((label, k) => {
      if (label === '' || picked.includes(k) || !rest.startsWith(label)) return;
      if (rest.length !== label.length && rest[label.length] !== ',') return;
      if (best < 0 || label.length > labels[best].length) best = k;
    });
    if (best < 0) break;
    picked.push(best);
    rest = rest.slice(labels[best].length + 1);
  }
  const typed = rest.trim();
  return { picked: picked.sort((a, b) => a - b), typed: typed === '' ? null : typed };
}
