import { useContext, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { LinkPreview, LinkPreviewWiki } from '@orbit/shared';
import { canonicalId, targetHref, type OrbitLinkRef } from '../lib/orbitLink';
import { WIKI_TRUST_TONE, WIKI_KIND_LABELS, type WikiEntryKind } from '../lib/wiki';
import type { WikiContext, WikiContextEntry } from '../lib/wikiContext';
import { OrbitLinkCardsCtx, type OrbitLinkCards } from './OrbitLinkCard';
import { WikiDot } from './WikiMarks';

/**
 * The wiki context a session was handed, opened: what the agent had read before it began.
 *
 * The folded line says how many notes rode along (`describeNote`), which is a count and nothing
 * else. This is the answer to the question that raises — WHICH notes — and it is drawn per entry as
 * the kind it is, the note itself, and who stands behind it.
 *
 * WHO STANDS BEHIND IT IS READ, NOT CARRIED. The push block names a kind, a title, a summary and the
 * entry's id, and nothing about trust: the block goes to the model, and what a model needs is the
 * note rather than the standing behind it. So each row asks the same question a link card asks, of
 * the same endpoint and the same `(kind, id)` key (`OrbitLinkCardsCtx`), and reads the trust off the
 * answer. That is also why a row wears no dot until its answer arrives — a dot is a claim about who
 * wrote an entry, and one drawn from a guess is worse than one drawn a moment later.
 *
 * EVERYTHING HERE DEGRADES TO NOTHING. Outside a conversation view there is no such context — the
 * shared page and the static export mount none — so a row is drawn as its kind and its title, with
 * no dot and no link, rather than reaching for a control plane that would not answer a visitor.
 */
export function WikiContextNote({ context }: { context: WikiContext }) {
  const cards = useContext(OrbitLinkCardsCtx);
  return (
    <div className="wkctx">
      <ul className="wkctx-list">
        {context.entries.map((entry) => (
          <WikiContextRow key={entry.id} entry={entry} cards={cards} />
        ))}
      </ul>
      <div className="wkctx-foot">{WIKI_CONTEXT_FILTER_NOTE}</div>
    </div>
  );
}

/** The block's own word for a kind (`[Principle]`), read through the Wiki's one table so a row here
 *  and a row in the drawer cannot name one kind two ways. A word the table does not know is drawn as
 *  the block wrote it rather than dropped. */
function kindWord(raw: string): string {
  const key = raw.toLowerCase();
  return Object.hasOwn(WIKI_KIND_LABELS, key) ? WIKI_KIND_LABELS[key as WikiEntryKind] : raw;
}

/** The link one row of the block stands for: the entry its line names, written as the block writes
 *  it. The same `(kind, id)` pair a card registers under, so a session showing a card for an entry
 *  AND that entry in its context note asks for it once. */
function entryLink(entry: WikiContextEntry): OrbitLinkRef | null {
  const id = canonicalId(entry.id);
  if (id === null) return null;
  return { target: { kind: 'wiki', id }, source: { kind: 'ref', ref: `orbit-wiki:${entry.id}` } };
}

function WikiContextRow({ entry, cards }: { entry: WikiContextEntry; cards: OrbitLinkCards | null }) {
  const link = useMemo(() => entryLink(entry), [entry]);
  // Registering is what asks for this entry, exactly as a card asks for its link. Skipped rather
  // than retried outside a conversation view, where there is no such context to ask.
  useEffect(() => {
    if (link) cards?.register(link);
  }, [cards, link]);

  const preview: LinkPreview | undefined = link ? cards?.previewFor(link) : undefined;
  const wiki: LinkPreviewWiki | undefined =
    preview?.state === 'ok' && preview.kind === 'wiki' ? preview.wiki : undefined;
  const href = link ? targetHref(link.target, wiki) : null;

  return (
    <li className="wkctx-row">
      {wiki && <WikiDot tone={WIKI_TRUST_TONE[wiki.trust]} />}
      <span className="wkctx-kind">{kindWord(entry.kind)}</span>
      {href !== null ? (
        <Link className="wkctx-title" to={href} title={entry.summary}>
          {entry.title}
        </Link>
      ) : (
        <span className="wkctx-title" title={entry.summary}>
          {entry.title}
        </span>
      )}
    </li>
  );
}

/**
 * The rule the block was filled by, said under the entries.
 *
 * From the contract's `push.eligible` (`contracts/wiki.contract.json`): an entry reaches a session
 * only if the owner wrote it or confirmed it, nothing has tainted it with web content, no challenge
 * is open against it, something first-hand still supports it, and its anchors have not moved. The
 * rule rather than a tally, deliberately: how many entries were held back is not on the wire — the
 * block carries what was SENT — and a number invented here would be the one thing on the card a
 * reader could not check.
 */
export const WIKI_CONTEXT_FILTER_NOTE =
  'Only entries you wrote or confirmed, with anchors that still hold and no open challenge.';
