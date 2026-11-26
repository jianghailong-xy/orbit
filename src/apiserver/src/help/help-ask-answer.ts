import type { HelpArticle, HelpAskMessage, HelpAskPage } from '@orbit/shared';

// One Ask answer on the server's own DeepSeek key (help-ask.ts): the prompt and the call. The rules are the ones a
// session-based Ask was told (runner-go help_ask.go helpAskSystemPrompt), with the articles and the account state
// handed over in the prompt instead of read through tools.

/** How long one answer may take, all of it. */
export const HELP_ASK_ANSWER_TIMEOUT_MS = 90_000;
/** Room for the answer: a few sentences or a short list of steps, and its sources. */
const MAX_TOKENS = 1_500;

/** Why an answer did not come, in words the person reads under their question. */
export class HelpAskAnswerFailed extends Error {}

/** Whether the server can answer an Ask at all: it holds a DeepSeek key. */
export function helpAskCanAnswer(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEEPSEEK_API_KEY?.trim());
}

const RULES = `<orbit_help_ask>
You are Orbit's help assistant. A person using Orbit asked a question from inside the app. You answer it, and you change nothing.

What you have, and nothing else:
- Orbit's help articles, in <orbit_help_articles> below. Each starts with its link (orbit:/help/<category>/<slug>).
- The person's account state as Orbit read it when they asked, in <orbit_account>: each machine (online or offline, and its last heartbeat), their newest sessions and where each stands, their open and failed tasks, and each machine's engine quota windows.
You cannot see repositories, files on the person's machines, transcripts, or keys, and you cannot change anything.

How to answer:
1. Every claim comes from an article or from the account state. Cite an article by a number in square brackets right after the sentence it supports, like [1]. Number the articles you cite 1, 2, 3 in the order you first cite them. Say what you read in the account state plainly ("build-box last checked in 2 h 4 min ago").
2. If the articles and the account state do not answer it, say you don't know, and say what you looked at. Never guess, and never answer from general knowledge about other products.
3. You never change anything. When the person should change something, offer it as a link they can press, written as a Markdown link to an orbit:/ path, such as [Open build-box](orbit:/settings/machines/<machine id>) or [Paused sessions](orbit:/sessions?view=open). Use paths the articles use, and ids from the account state. Never tell the person you did something.
4. Keep it short: a few sentences, or a short numbered list of steps. Plain English.
5. End with the sources you cited, one per line, after a line that says "Sources:", each as
   [n] [Article title](orbit:/help/<category>/<slug>)
   Leave the list out when you cited none.
</orbit_help_ask>`;

/** The rules and every article the person may read: the same for every Ask they make, so DeepSeek caches it. */
export function helpAskLibraryPrompt(articles: readonly HelpArticle[]): string {
  const parts = articles.map(
    (a) => `<article>\n# ${a.title}\nLink: orbit:/help/${a.category}/${a.slug}\nSummary: ${a.summary}\n\n${a.body.trim()}\n</article>`,
  );
  return `${RULES}\n\n<orbit_help_articles>\n${parts.join('\n\n')}\n</orbit_help_articles>`;
}

/** What changes from question to question: the account state just read, the time, and the page asked from. */
export function helpAskContextPrompt(input: { account: unknown; page: HelpAskPage | null; now: Date }): string {
  let out = `<orbit_account>\nRead at ${input.now.toISOString()}.\n${JSON.stringify(input.account)}\n</orbit_account>`;
  if (input.page) {
    out += `\n\n<orbit_help_page>\nThe person asked from this page of Orbit: ${input.page.label} (${input.page.route}).`;
    if (input.page.errors.length > 0) out += ` It shows these errors:\n${input.page.errors.map((e) => `- ${e}`).join('\n')}`;
    out += '\nArticles about this page list its path in their routes; start with those.\n</orbit_help_page>';
  }
  return out;
}

/** The conversation as chat messages: each question, and each answer that came. */
export function helpAskChatMessages(messages: readonly HelpAskMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages.filter((m) => !m.error && m.text.trim() !== '').map((m) => ({ role: m.role, content: m.text }));
}

/** Ask DeepSeek. Resolves to the answer's Markdown; rejects with HelpAskAnswerFailed. */
export async function askDeepSeek(
  input: { library: string; context: string; messages: readonly HelpAskMessage[] },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new HelpAskAnswerFailed('This Orbit server has no DeepSeek key, so Ask cannot answer.');
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/u, '');
  let resp: Response;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || 'deepseek-chat',
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: input.library },
          { role: 'system', content: input.context },
          ...helpAskChatMessages(input.messages),
        ],
      }),
      signal: AbortSignal.timeout(HELP_ASK_ANSWER_TIMEOUT_MS),
    });
  } catch {
    throw new HelpAskAnswerFailed('DeepSeek could not be reached, or took too long. Ask again.');
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => undefined);
    throw new HelpAskAnswerFailed(`DeepSeek answered ${resp.status}. Ask again in a moment.`);
  }
  const data = (await resp.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new HelpAskAnswerFailed('DeepSeek returned no answer. Ask again.');
  return content.trim();
}
