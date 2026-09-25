import { BranchesOutlined, FileTextOutlined } from '@ant-design/icons';
import { OrbitLinkCard } from './OrbitLinkCard';
import { statusLabel } from './WorkspaceView';
import { decodeId } from '../lib/idCodec';
import { WIKI_QUOTE_UNVERIFIED, WIKI_QUOTE_VERIFIED, shortSha, type WikiSource } from '../lib/wiki';

/**
 * An entry's sources: the first-hand records it was compiled from, each with the words it took.
 *
 * A SOURCE IS NEVER ANOTHER WIKI PAGE (design §5, contract `sourceRules.firstHand`), so what is drawn
 * here is always a record of something that happened — a turn, a tool call, a task, a commit — and
 * the card is the conversation's own `.orbit-link-card` wherever the record has an Orbit page. What
 * the Wiki adds to it is the quote: the words the entry took, and whether the server found them in
 * the record it cites (`quote verified ✓`), which is what separates a citation from a paraphrase.
 *
 * A TURN IS A SESSION. `resolveSources` stores the SESSION's id on a turn cited from the session
 * that made it and the TURN's id on one cited by id, and the two are told apart by `locator.turnId`
 * (present only in the first case) — so a session card is drawn exactly when there is a session to
 * draw, and a turn cited by its own id gets the plain line rather than a card pointing at nothing.
 */

/**
 * The host a link card's mono hint names.
 *
 * Read through one function because a card is drawn while the page is being SERVER-rendered too — a
 * static render has no address bar, and `window.location.host` read directly is a crash rather than
 * an empty hint.
 */
export function wikiLinkHost(): string {
  return typeof window === 'undefined' ? '' : window.location.host;
}

/** The card an Orbit record gets, when the record has one. */
export function wikiSourceLink(source: WikiSource): { kind: 'task' | 'session'; id: string } | null {
  if (source.kind === 'task') return { kind: 'task', id: source.ref };
  if (source.kind === 'turn' && typeof source.locator?.turnId === 'string') {
    return { kind: 'session', id: source.ref };
  }
  return null;
}

/** The word a source's record goes by, for the lines that have no Orbit page of their own. */
const SOURCE_WORDS: Partial<Record<string, string>> = {
  turn: 'Turn',
  event: 'Event',
  tool_call: 'Tool call',
  task: 'Task',
  task_comment: 'Task comment',
  approval: 'Approval',
  evidence: 'Evidence',
  owner_decision: 'Your decision',
  merge_receipt: 'Merge receipt',
  criterion: 'Criterion',
  commit: 'Commit',
  note: 'Note',
};

export function wikiSourceWord(source: Pick<WikiSource, 'kind'>): string {
  return SOURCE_WORDS[source.kind] ?? source.kind;
}

/** The mono hint under a source's own line: the record's id, or the path it names. */
export function wikiSourceRefText(source: WikiSource): string {
  const locator = source.locator ?? {};
  if (typeof locator.path === 'string') return locator.path;
  if (typeof locator.url === 'string') return locator.url;
  if (source.kind === 'commit') return shortSha(source.ref);
  return shortSha(source.ref);
}

export function WikiSourceList({ sources }: { sources: readonly WikiSource[] }) {
  return (
    <div className="wk-dsrc">
      {sources.map((source) => {
        const link = wikiSourceLink(source);
        if (link) {
          return (
            <div className="wk-src-card" key={source.id}>
              <OrbitLinkCard
                link={{ target: { kind: link.kind, id: decodeId(link.id) ?? link.id }, source: { kind: 'ref', ref: link.id } }}
                host={wikiLinkHost()}
                stateWord={statusLabel}
              />
              <WikiSourceQuote source={source} />
            </div>
          );
        }
        return <WikiSourceLine key={source.id} source={source} />;
      })}
    </div>
  );
}

/** A source with no Orbit page: its kind, its record, and the words it was cited for. */
function WikiSourceLine({ source }: { source: WikiSource }) {
  const isCommit = source.kind === 'commit';
  return (
    <div className="wk-commit">
      <div className="h">
        {isCommit ? <BranchesOutlined className="ic" /> : <FileTextOutlined className="ic" />}
        <span className={isCommit ? 'sha' : ''}>{wikiSourceWord(source)}</span>
        <span className="wk-mono ref">{wikiSourceRefText(source)}</span>
      </div>
      <WikiSourceQuote source={source} />
    </div>
  );
}

/**
 * The quote, and whether the server found it in the record it cites.
 *
 * `quoteVerified` is false for two different things — a quote this database cannot read (a commit's
 * contents, a turn not yet stored) and no quote at all — so the tick appears only when a quote was
 * checked, and a quote that was kept unverified says so in words rather than wearing a tick it did
 * not earn.
 */
function WikiSourceQuote({ source }: { source: WikiSource }) {
  if (!source.quote) return null;
  return (
    <div className="olc-quote">
      <span className="wk-quote-text">{source.quote}</span>
      <div className="who">
        <span>{wikiSourceWord(source)}</span>
        {source.quoteVerified ? (
          <span className="ver">{WIKI_QUOTE_VERIFIED}</span>
        ) : (
          <span className="unverified">{WIKI_QUOTE_UNVERIFIED}</span>
        )}
      </div>
    </div>
  );
}
