import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClockCircleOutlined } from '@ant-design/icons';
import {
  getSharedWikiDoc,
  type ShareInclude,
  type SharedWiki,
  type SharedWikiDoc,
  type SharedWikiDocPage,
  type SharedWikiFootnote,
} from '../api';
import { PublicShell } from '../components/PublicShell';
import { Drawer } from '../components/ui/Drawer';
import { Popover } from '../components/ui/Popover';
import { WikiDocRow } from '../components/WikiDocList';
import { WikiDocFootnoteCard, WikiDocFootnoteList } from '../components/WikiDocPage';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { WIKI_HISTORY_MAINTENANCE, WIKI_TITLE } from '../lib/wiki';
import { wikiSentenceSegments } from '../lib/wikiArticles';
import {
  WIKI_DOC_COVERS,
  WIKI_DOC_NOT_COVERED,
  WIKI_DOC_QUESTION,
  WIKI_DOC_WRITTEN_FOR,
  WIKI_FOOTNOTE_KIND_LABELS,
  WIKI_NO_DOCUMENTS,
  wikiDocSectionAnchor,
  wikiDocTags,
  wikiDocumentCount,
  wikiFootnoteIsRepo,
  wikiScopeTarget,
  type WikiDocFootnoteView,
  type WikiDocViaEntry,
} from '../lib/wikiDocs';
import { wikiMonthDay } from '../lib/wikiReviewMode';
import { SharedLoading, SharedUnavailable } from './SharedSessionPage';

/**
 * A wiki link's public pages (docs/share-links-design.md §10, mock share-links 09): the space's home at
 * `/s/<token>` and one written document at `/s/<token>/d/<slug>`, in the frame every public page shares
 * (PublicShell). Both are the app's own pages — the home's rows, the document's sections, footnote card
 * and footnote list, under the app's CSS — with what only the owner reads taken out: the directory and
 * Contents, the marks a sentence wears, the review banner, the entries, the plan, every way into the
 * owner's account. Nothing here links anywhere but to another page of the same link.
 */

/** A shared wiki is named by its space: `orbit · Wiki`. */
const wikiCrumb = (name: string): string => `${name} · ${WIKI_TITLE}`;
const sharedRoot = (token: string): string => `/s/${encodeURIComponent(token)}`;
const sharedDocPath = (token: string, slug: string): string => `${sharedRoot(token)}/d/${encodeURIComponent(slug)}`;

/** No entry is ever named to a visitor: the footnote card and list are handed none. */
const NO_ENTRIES: Map<string, WikiDocViaEntry> = new Map();

function usePageTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} — Orbit`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/**
 * `/s/<token>` for a wiki link: the space's written documents by category — the app home's own rows,
 * a number, a title and the document's lead — and nothing the plan has that is not written yet.
 */
export function SharedWikiHome({ token, data }: { token: string; data: { include: ShareInclude; root: SharedWiki } }) {
  const wiki = data.root;
  usePageTitle(wikiCrumb(wiki.name));
  return (
    <PublicShell crumbs={[{ label: wikiCrumb(wiki.name) }]} wide>
      <div className="share-wiki">
        <div className="wk-title-row">
          <h1 className="page-title">{WIKI_TITLE}</h1>
          <span className="wk-space-tag">{wiki.name}</span>
        </div>
        <div className="wk-home-state">{wiki.documents > 0 ? wikiDocumentCount(wiki.documents) : WIKI_NO_DOCUMENTS}</div>
        {wiki.categories.length > 0 && (
          <div className="wk-home">
            {wiki.categories.map((category) => (
              <section className="wk-pl-cat" key={category.key}>
                <div className="wk-pl-cat-h">
                  <span className="no">{category.number}</span>
                  <b>{category.title}</b>
                </div>
                {category.docs.map((doc) => (
                  <WikiDocRow
                    key={doc.slug}
                    to={sharedDocPath(token, doc.slug)}
                    number={doc.number}
                    title={doc.title}
                    line={doc.lead ?? undefined}
                    lead
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </PublicShell>
  );
}

/**
 * `/s/<token>/d/<slug>`: one written document of a wiki link. Anything the link does not open is the
 * same page a dead link shows. Not counted as a view: only the home is.
 */
export function SharedWikiDocRoute() {
  const { token = '', slug = '' } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['shared', token, 'd', slug],
    queryFn: () => getSharedWikiDoc(token, slug),
    enabled: !!token && !!slug,
    retry: false,
    staleTime: Infinity,
  });
  if (isLoading) return <SharedLoading />;
  if (isError || !data) return <SharedUnavailable />;
  return <SharedWikiDocument key={slug} token={token} data={data} />;
}

/** A visitor's footnote as the app's card and list read one: every way back into the account empty. */
function footnoteView(note: SharedWikiFootnote): WikiDocFootnoteView {
  return {
    ...note,
    checkedBy: wikiFootnoteIsRepo(note) ? 'runner' : 'server',
    location: note.path ?? note.notePath ?? WIKI_FOOTNOTE_KIND_LABELS[note.kind],
    sha: null,
    recordId: null,
    charStart: null,
    charEnd: null,
    sessionId: null,
    sessionTitle: null,
    taskId: null,
    taskTitle: null,
    projectId: null,
    projectTitle: null,
    viaEntryId: null,
  };
}

/** Which sentence's footnote is open, and which of its numbers. */
interface OpenNote {
  at: string;
  n: number;
}

/**
 * A document as a visitor reads it: the title, its tags and when it was written, its reader and scope,
 * the sections, and — with Footnotes — a number after each sourced sentence that opens the app's footnote
 * card (a popover on a desktop, a sheet on a phone) and the app's footnote list under the text.
 */
function SharedWikiDocument({ token, data }: { token: string; data: SharedWikiDocPage }) {
  const { doc, wiki } = data;
  const phone = useMediaQuery(MOBILE_QUERY);
  const [open, setOpen] = useState<OpenNote | null>(null);
  const footnotes = useMemo(() => (doc.footnotes ?? []).map(footnoteView), [doc.footnotes]);
  const notes = useMemo(() => new Map(footnotes.map((note) => [note.n, note])), [footnotes]);
  const day = doc.updatedAt ? wikiMonthDay(doc.updatedAt) : null;
  usePageTitle(doc.title);

  /** The first place the text carries footnote `n`, which a row of the list opens its card at. */
  const openFromList = (n: number) => {
    for (const section of doc.sections) {
      for (const [b, block] of section.blocks.entries()) {
        for (const [s, sentence] of block.sentences.entries()) {
          if (!sentence.notes.includes(n)) continue;
          setOpen({ at: `${section.key}.${b}.${s}`, n });
          document.getElementById(`wk-fnref-${n}`)?.scrollIntoView?.({ block: 'center' });
          return;
        }
      }
    }
  };

  return (
    <PublicShell crumbs={[{ label: wikiCrumb(wiki.name), to: sharedRoot(token) }, { label: doc.title }]} wide>
      <article className="wk-art-page wk-dc-page share-wiki-doc">
        <h1 className="t-title wk-art-title">{doc.title}</h1>
        <div className="wk-tags">
          <span className="wk-tag cat">{doc.category.title}</span>
          {wikiDocTags({ sections: doc.sections, footnotes }).map((tag) => (
            <span className="wk-tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        {day && (
          <div className="t-meta wk-art-updated">
            <ClockCircleOutlined className="ic" />
            <span>
              Updated {day} · written by {WIKI_HISTORY_MAINTENANCE}
            </span>
          </div>
        )}
        <SharedWikiScope doc={doc} token={token} />
        <div className="wk-art wk-dc-body">
          {doc.sections.map((section) => (
            <section className="wk-dc-sec" id={wikiDocSectionAnchor(section.key)} key={section.key}>
              <h2>
                <span className="no">{section.number}</span>
                {section.title}
              </h2>
              {blockRuns(section.blocks).map((run) => {
                const sentences = (b: number) =>
                  section.blocks[b].sentences.map((sentence, s) => (
                    <SharedWikiSentence
                      key={s}
                      at={`${section.key}.${b}.${s}`}
                      text={sentence.text}
                      numbers={sentence.notes}
                      notes={notes}
                      open={open}
                      setOpen={setOpen}
                      phone={phone}
                      docSlug={doc.slug}
                    />
                  ));
                if (run.kind === 'items') {
                  return (
                    <ul key={run.at[0]}>
                      {run.at.map((b) => (
                        <li key={b}>{sentences(b)}</li>
                      ))}
                    </ul>
                  );
                }
                if (run.kind === 'heading') return <h3 key={run.at[0]}>{section.blocks[run.at[0]].text}</h3>;
                if (run.kind === 'code') {
                  return (
                    <pre key={run.at[0]} className="wk-dc-code">
                      <code>{section.blocks[run.at[0]].text}</code>
                    </pre>
                  );
                }
                return <p key={run.at[0]}>{sentences(run.at[0])}</p>;
              })}
            </section>
          ))}
        </div>
        {phone && (
          <Drawer
            placement="bottom"
            open={open !== null}
            onClose={() => setOpen(null)}
            height="auto"
            closable={false}
            title={null}
            className="wk-fnsheet"
          >
            {open && notes.get(open.n) && (
              <WikiDocFootnoteCard note={notes.get(open.n)!} via={NO_ENTRIES} github={null} spaceSlug="" docSlug={doc.slug} sheet visitor />
            )}
          </Drawer>
        )}
        {footnotes.length > 0 && (
          <WikiDocFootnoteList doc={{ footnotes }} via={NO_ENTRIES} lit={open?.n ?? null} onOpen={openFromList} />
        )}
      </article>
    </PublicShell>
  );
}

/** A run of paragraphs, list items, headings and code, the list items of a row gathered into one list. */
function blockRuns(blocks: SharedWikiDoc['sections'][number]['blocks']): Array<{ kind: 'paragraph' | 'items' | 'heading' | 'code'; at: number[] }> {
  const runs: Array<{ kind: 'paragraph' | 'items' | 'heading' | 'code'; at: number[] }> = [];
  blocks.forEach((block, b) => {
    const kind = block.kind === 'item' ? 'items' : block.kind;
    const last = runs[runs.length - 1];
    if (kind === 'items' && last?.kind === 'items') last.at.push(b);
    else runs.push({ kind, at: [b] });
  });
  return runs;
}

/**
 * The reader and scope: the document's question, who it is written for, what it covers and what it
 * leaves to another document — a link to that one's page when the link opens it, its number otherwise.
 */
function SharedWikiScope({ doc, token }: { doc: SharedWikiDoc; token: string }) {
  return (
    <div className="wk-dc-scope">
      <div className="k">{WIKI_DOC_QUESTION}</div>
      <div className="v q">{doc.question}</div>
      <div className="k">{WIKI_DOC_WRITTEN_FOR}</div>
      <div className="v">
        <ul>
          {doc.audience.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="k">{WIKI_DOC_COVERS}</div>
      <div className="v">
        <ul>
          {doc.scopeIn.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      {doc.scopeOut.length > 0 && (
        <>
          <div className="k">{WIKI_DOC_NOT_COVERED}</div>
          <div className="v">
            <ul>
              {doc.scopeOut.map((out) => (
                <li key={out.text}>
                  {out.text}
                  {out.docs.map((target) =>
                    target.slug ? (
                      <Link key={target.slug} className="see" to={sharedDocPath(token, target.slug)}>
                        {' '}
                        {wikiScopeTarget({ ...target, slug: target.slug })}
                      </Link>
                    ) : (
                      <span key={`${target.number}-${target.title}`} className="see off">
                        {' '}
                        {wikiScopeTarget({ ...target, slug: '' })}
                      </span>
                    ),
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** One sentence: its words, and — with Footnotes — its footnote numbers, each opening the card. */
function SharedWikiSentence({
  at,
  text,
  numbers,
  notes,
  open,
  setOpen,
  phone,
  docSlug,
}: {
  at: string;
  text: string;
  numbers: number[];
  notes: Map<number, WikiDocFootnoteView>;
  open: OpenNote | null;
  setOpen: (open: OpenNote | null) => void;
  phone: boolean;
  docSlug: string;
}) {
  const lit = open?.at === at;
  const words = wikiSentenceSegments(text).map((segment, i) =>
    segment.kind === 'code' ? (
      <code key={i}>{segment.text}</code>
    ) : segment.kind === 'strong' ? (
      <strong key={i}>{segment.text}</strong>
    ) : (
      <Fragment key={i}>{segment.text}</Fragment>
    ),
  );
  return (
    <>
      <span className={lit ? 'hl' : undefined}>{words}</span>
      {numbers.length > 0 && (
        <sup className="wk-fn">
          {numbers.map((n, i) => {
            const footnote = notes.get(n);
            const on = lit && open?.n === n;
            const marker = (
              <button
                type="button"
                id={i === 0 ? `wk-fnref-${n}` : undefined}
                className={`wk-fn-n${on ? ' on' : ''}${footnote && footnote.verdict !== 'verified' ? ' x' : ''}`}
                aria-label={`Footnote ${n}`}
                onClick={() => setOpen(on ? null : { at, n })}
              >
                [{n}]
              </button>
            );
            if (phone || !footnote) return <Fragment key={n}>{marker}</Fragment>;
            return (
              <Popover
                key={n}
                open={on}
                side="bottom"
                align="start"
                pointAtCenter
                title={null}
                onOpenChange={(visible) => {
                  if (!visible && on) setOpen(null);
                }}
                trigger={marker}
              >
                <WikiDocFootnoteCard note={footnote} via={NO_ENTRIES} github={null} spaceSlug="" docSlug={docSlug} visitor />
              </Popover>
            );
          })}
        </sup>
      )}{' '}
    </>
  );
}
