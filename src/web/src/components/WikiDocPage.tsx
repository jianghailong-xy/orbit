import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ClockCircleOutlined,
  CodeOutlined,
  CommentOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  FileTextOutlined,
  MessageOutlined,
  ProfileOutlined,
  RightOutlined,
  SyncOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { WikiEmpty } from './WikiCards';
import { WIKI_DOC_SECTION_EVENT, WikiContentsButton } from './WikiDirectory';
import { WikiAnchorMark, WikiKindMark, WikiStatusBadge, WikiTrustBadge } from './WikiMarks';
import { Button, LinkButton } from './ui/Button';
import { Drawer } from './ui/Drawer';
import { Popover } from './ui/Popover';
import { Tooltip } from './ui/Tooltip';
import { wikiDocQuery, wikiDocsQuery, wikiEntriesQuery, wikiSpaceQuery } from '../lib/queries';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  WIKI_COL_ANCHOR,
  WIKI_COL_CONFIRMED_BY,
  WIKI_COL_THIS_WEEK,
  WIKI_TITLE,
  wikiAnchorMark,
  wikiEntryPath,
  wikiShowMore,
  wikiSpacePath,
  type WikiEntry,
  type WikiTrust,
} from '../lib/wiki';
import { wikiBrowsePath, wikiSentenceSegments } from '../lib/wikiArticles';
import {
  WIKI_DOC_COVERS,
  WIKI_DOC_ENTRIES,
  WIKI_DOC_FOOTNOTES,
  WIKI_DOC_GROUP_SHOWN,
  WIKI_DOC_GROUP_SHOWN_PHONE,
  WIKI_DOC_NEEDS_REVIEW,
  WIKI_DOC_NOT_COVERED,
  WIKI_DOC_NOT_WRITTEN,
  WIKI_DOC_QUESTION,
  WIKI_DOC_SCOPE_FOLDED,
  WIKI_DOC_SECTION_NOT_WRITTEN,
  WIKI_DOC_WRITTEN_FOR,
  WIKI_EXCERPT_LINES,
  WIKI_EXCERPT_LINES_PHONE,
  WIKI_FOOTNOTES_SHOWN,
  WIKI_FOOTNOTE_KIND_LABELS,
  WIKI_MARK_LABELS,
  WIKI_NEXT_MARKED,
  WIKI_NO_QUOTE_GIVEN,
  WIKI_OPEN_THE_ENTRY,
  WIKI_OWNER_COMMENT,
  WIKI_REWRITE_PENDING,
  WIKI_VERDICT_CARD,
  WIKI_VERDICT_LIST,
  WIKI_VIA_ENTRY,
  wikiDocEntriesHint,
  wikiDocEntryGroups,
  wikiDocLegend,
  wikiDocNeedsReviewText,
  wikiDocNotWrittenNote,
  wikiDocPath,
  wikiDocRewriteNote,
  wikiDocScopeCounts,
  wikiDocSectionAnchor,
  wikiDocTags,
  wikiDocUpdatedParts,
  wikiDocUpdatedWarn,
  wikiEntrySummaries,
  wikiExcerptLines,
  wikiFootnoteIsRepo,
  wikiFootnoteOpen,
  wikiFootnoteOpenInline,
  wikiFootnotePlace,
  wikiFootnoteProblem,
  wikiFootnoteSubLabel,
  wikiFootnoteWhere,
  wikiFootnotesSummary,
  wikiGithubRepo,
  wikiMarkNote,
  wikiMoreLines,
  wikiQuoted,
  wikiScopeTarget,
  wikiSeeFootnote,
  wikiSentenceMark,
  wikiViaEntryNote,
  wikiViaEntryStatus,
  type WikiDocFootnoteView,
  type WikiDocSectionView,
  type WikiDocSentenceView,
  type WikiDocView,
  type WikiDocViaEntry,
  type WikiFootnoteOpen,
} from '../lib/wikiDocs';

/**
 * A document's page (criterion 10 revised 2026-09-28, mocks 23–24): the crumb, the title, the tags, when
 * and from what it was written, the banner of a document past the threshold, its reader and scope, the
 * text section by section with a superscript footnote after each sourced sentence and a mark after each
 * that is not, the footnotes, and the entries its quotes came through. The order is the web phone's and
 * iOS's alike (`WIKI_DOC_SECTIONS`, held by `WikiDocsCopyParityTests`).
 *
 * A FOOTNOTE SHOWS ITS ORIGINAL, not an entry: the words it quotes, or the lines of code it cites with the
 * quoted line lit; where they are — a session record opens at that very record, repository lines on
 * GitHub at the commit the run read them at — and the entry it was found through, as one line. A popover
 * beside the number on a desktop; on a phone a sheet from the bottom whose one button opens the original
 * (owner's call 2026-09-29, over mock 14's Open entry).
 *
 * A MARKED SENTENCE SAYS WHY: No source (amber), Not verified (red) and Withdrawn (struck, and its section
 * marked Rewrite pending — owner's call 2026-09-29 to keep it in place rather than hide it). Hovering it on
 * a desktop, tapping it on a phone, says what the mark means and what happens next.
 */
export function WikiDocRoute({ spaceId, spaceSlug, slug }: { spaceId: string; spaceSlug: string; slug: string }) {
  const doc = useQuery(wikiDocQuery(spaceId, slug));
  const directory = useQuery(wikiDocsQuery(spaceId));
  const space = useQuery(wikiSpaceQuery(spaceId));
  const entries = useQuery(wikiEntriesQuery(spaceId));
  if (doc.data === null) return <WikiEmpty>That document is not in this space’s plan.</WikiEmpty>;
  if (doc.isError) return <WikiEmpty>The document couldn’t be loaded. Check the connection, then try again.</WikiEmpty>;
  if (!doc.data) return <div className="wk-art-page" aria-busy={doc.isPending} />;
  return (
    <WikiDocPage
      doc={doc.data}
      spaceSlug={spaceSlug}
      github={wikiGithubRepo(space.data?.repoUrlNorm)}
      docs={directory.data ? directory.data.docs : null}
      entries={entries.data}
    />
  );
}

/** Which sentence's footnote is open, and which of its numbers. */
interface OpenNote {
  at: string;
  n: number;
}

export function WikiDocPage({
  doc,
  spaceSlug,
  github,
  docs,
  entries,
}: {
  doc: WikiDocView;
  spaceSlug: string;
  github: string | null;
  docs: { written: number; total: number } | null;
  entries?: readonly WikiEntry[];
}) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const location = useLocation();
  const [open, setOpen] = useState<OpenNote | null>(null);
  const notes = useMemo(() => new Map(doc.footnotes.map((note) => [note.n, note])), [doc.footnotes]);
  const via = useMemo(() => new Map(doc.entries.map((entry) => [entry.id, entry])), [doc.entries]);
  const byId = useMemo(() => new Map((entries ?? []).map((entry) => [entry.id, entry])), [entries]);
  const tags = wikiDocTags(doc);
  const updated = wikiDocUpdatedParts(doc);
  const warn = wikiDocUpdatedWarn(doc);

  // The section on screen, for the directory to light (`WIKI_DOC_SECTION_EVENT`): the topmost one whose
  // heading has come into the top half of the window. jsdom has no IntersectionObserver; nothing is lit there.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) seen.set((record.target as HTMLElement).dataset.section ?? '', record.isIntersecting);
        const key = doc.sections.find((section) => seen.get(section.key))?.key;
        if (key) window.dispatchEvent(new CustomEvent(WIKI_DOC_SECTION_EVENT, { detail: { slug: doc.slug, key } }));
      },
      { rootMargin: '0px 0px -50% 0px' },
    );
    document.querySelectorAll('.wk-dc-sec').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [doc.slug, doc.sections]);

  // The directory's section rows and the index's section rows land on `#sec-<key>`.
  useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    target?.scrollIntoView?.({ block: 'start' });
  }, [location.hash, doc.slug]);

  /** The first place the text carries a footnote, which a row of the list opens its card at. */
  const firstAt = useCallback(
    (n: number): string | null => {
      for (const section of doc.sections) {
        for (const [b, block] of section.blocks.entries()) {
          for (const [s, sentence] of block.sentences.entries()) if (sentence.notes.includes(n)) return `${section.key}.${b}.${s}`;
        }
      }
      return null;
    },
    [doc.sections],
  );
  const openFromList = (n: number) => {
    const at = firstAt(n);
    if (!at) return;
    setOpen({ at, n });
    document.getElementById(`wk-fnref-${n}`)?.scrollIntoView?.({ block: 'center' });
  };

  return (
    <article className="wk-art-page wk-dc-page">
      <div className="wk-art-crumbrow">
        <div className="wk-crumb">
          <Link to={wikiSpacePath(spaceSlug)}>{WIKI_TITLE}</Link>
          <RightOutlined className="ic" />
          <Link to={`${wikiBrowsePath(spaceSlug)}#wk-cat-${doc.category.key}`}>{doc.category.title}</Link>
        </div>
        <WikiContentsButton />
      </div>
      <h1 className="t-title wk-art-title">{doc.title}</h1>
      <div className="wk-tags">
        <span className="wk-tag cat">{doc.category.title}</span>
        {tags.map((tag) => (
          <span className="wk-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      {doc.written ? (
        <div className="t-meta wk-art-updated">
          <ClockCircleOutlined className="ic" />
          <span>{updated.join(' · ')}</span>
          {warn && <span className="wk-dc-warn"> · {warn}</span>}
        </div>
      ) : (
        <div className="wk-dc-notwritten">
          <ClockCircleOutlined className="ic" />
          <span>
            <b>{WIKI_DOC_NOT_WRITTEN}</b> {wikiDocNotWrittenNote(docs)}
          </span>
        </div>
      )}
      {doc.status === 'needs_review' && <WikiDocReviewBanner doc={doc} />}
      <WikiDocScope doc={doc} spaceSlug={spaceSlug} phone={phone} />

      <div className="wk-art wk-dc-body">
        {doc.sections.map((section) => (
          <WikiDocSectionText
            key={section.key}
            doc={doc}
            section={section}
            notes={notes}
            open={open}
            setOpen={setOpen}
            phone={phone}
            github={github}
            spaceSlug={spaceSlug}
            via={via}
          />
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
            <WikiDocFootnoteCard note={notes.get(open.n)!} via={via} github={github} spaceSlug={spaceSlug} docSlug={doc.slug} sheet />
          )}
        </Drawer>
      )}

      {doc.footnotes.length > 0 && (
        <WikiDocFootnoteList doc={doc} via={via} lit={open?.n ?? null} onOpen={openFromList} />
      )}
      {doc.entries.length > 0 && <WikiDocEntries doc={doc} spaceSlug={spaceSlug} byId={byId} phone={phone} />}
    </article>
  );
}

/** The banner over a document past the threshold (mock 23 ③): how many, why, the legend, and Next marked. */
function WikiDocReviewBanner({ doc }: { doc: WikiDocView }) {
  const legend = wikiDocLegend(doc);
  const rewrite = wikiDocRewriteNote(doc.sections);
  const next = () => {
    const marked = [...document.querySelectorAll<HTMLElement>('.wk-dc-body [data-mark]')];
    const below = marked.find((node) => node.getBoundingClientRect().top > 96) ?? marked[0];
    below?.scrollIntoView?.({ block: 'center' });
  };
  return (
    <div className="wk-dc-banner" role="status">
      <ExclamationCircleFilled className="ic" />
      <div>
        <b className="h">{WIKI_DOC_NEEDS_REVIEW}</b> · {wikiDocNeedsReviewText(doc)}
        <div className="lg">
          {legend.map((item) => (
            <span key={item.mark}>
              <span className={`wk-s-lab ${LAB_CLASS[item.mark]}`}>{item.label}</span> {item.count}
              {item.mark === 'withdrawn' && rewrite ? ` · ${rewrite}` : ''}
            </span>
          ))}
          <button type="button" className="go" onClick={next}>
            {WIKI_NEXT_MARKED}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The reader and scope (mock 23 ④): the plan document's question, readers, what it covers and leaves out. */
function WikiDocScope({ doc, spaceSlug, phone }: { doc: WikiDocView; spaceSlug: string; phone: boolean }) {
  const [unfolded, setUnfolded] = useState(false);
  const rest = (
    <>
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
                  {out.docs.map((target) => (
                    <Link key={target.slug} className="see" to={wikiDocPath(spaceSlug, target.slug)}>
                      {' '}
                      {wikiScopeTarget(target)}
                    </Link>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
  return (
    <div className={`wk-dc-scope${phone ? ' phone' : ''}`}>
      <div className="k">{WIKI_DOC_QUESTION}</div>
      <div className="v q">{doc.question}</div>
      {phone && !unfolded ? (
        <button type="button" className="wk-dc-fold" aria-expanded={false} onClick={() => setUnfolded(true)}>
          <span>{WIKI_DOC_SCOPE_FOLDED}</span>
          <span className="n">{wikiDocScopeCounts(doc)}</span>
          <DownOutlined className="ic" />
        </button>
      ) : (
        rest
      )}
      {phone && unfolded && (
        <button type="button" className="wk-dc-fold up" aria-expanded onClick={() => setUnfolded(false)}>
          <UpOutlined className="ic" />
        </button>
      )}
    </div>
  );
}

/** A run of paragraphs, list items, headings and code, the list items of a row gathered into one list. */
function blockRuns(section: WikiDocSectionView): Array<{ kind: 'paragraph' | 'items' | 'heading' | 'code'; at: number[] }> {
  const runs: Array<{ kind: 'paragraph' | 'items' | 'heading' | 'code'; at: number[] }> = [];
  section.blocks.forEach((block, b) => {
    const kind = block.kind === 'item' ? 'items' : block.kind;
    const last = runs[runs.length - 1];
    if (kind === 'items' && last?.kind === 'items') last.at.push(b);
    else runs.push({ kind, at: [b] });
  });
  return runs;
}

function WikiDocSectionText({
  doc,
  section,
  notes,
  open,
  setOpen,
  phone,
  github,
  spaceSlug,
  via,
}: {
  doc: WikiDocView;
  section: WikiDocSectionView;
  notes: Map<number, WikiDocFootnoteView>;
  open: OpenNote | null;
  setOpen: (open: OpenNote | null) => void;
  phone: boolean;
  github: string | null;
  spaceSlug: string;
  via: Map<string, WikiDocViaEntry>;
}) {
  const sentences = (b: number) =>
    section.blocks[b].sentences.map((sentence, s) => (
      <WikiDocSentence
        key={s}
        at={`${section.key}.${b}.${s}`}
        doc={doc}
        section={section}
        sentence={sentence}
        notes={notes}
        open={open}
        setOpen={setOpen}
        phone={phone}
        github={github}
        spaceSlug={spaceSlug}
        via={via}
      />
    ));
  return (
    <section className="wk-dc-sec" id={wikiDocSectionAnchor(section.key)} data-section={section.key}>
      <h2>
        <span className="no">{section.number}</span>
        {section.title}
        {section.stale && (
          <span className="wk-dc-tag">
            <SyncOutlined className="ic" />
            {WIKI_REWRITE_PENDING}
          </span>
        )}
      </h2>
      {!section.written ? (
        <p className="wk-dc-unwritten">{WIKI_DOC_SECTION_NOT_WRITTEN}</p>
      ) : (
        blockRuns(section).map((run) =>
          run.kind === 'items' ? (
            <ul key={run.at[0]}>
              {run.at.map((b) => (
                <li key={b}>{sentences(b)}</li>
              ))}
            </ul>
          ) : run.kind === 'heading' ? (
            <h3 key={run.at[0]}>{section.blocks[run.at[0]].text}</h3>
          ) : run.kind === 'code' ? (
            <pre key={run.at[0]} className="wk-dc-code">
              <code>{section.blocks[run.at[0]].text}</code>
            </pre>
          ) : (
            <p key={run.at[0]}>{sentences(run.at[0])}</p>
          ),
        )
      )}
    </section>
  );
}

const MARK_CLASS = { unsourced: 'wk-s-nosrc', unverified: 'wk-s-bad', withdrawn: 'wk-s-gone' } as const;
const LAB_CLASS = { unsourced: 'nosrc', unverified: 'bad', withdrawn: 'gone' } as const;

/** One sentence: its runs, its footnote numbers, and — marked — its mark, with what the mark means. */
function WikiDocSentence({
  at,
  doc,
  section,
  sentence,
  notes,
  open,
  setOpen,
  phone,
  github,
  spaceSlug,
  via,
}: {
  at: string;
  doc: WikiDocView;
  section: WikiDocSectionView;
  sentence: WikiDocSentenceView;
  notes: Map<number, WikiDocFootnoteView>;
  open: OpenNote | null;
  setOpen: (open: OpenNote | null) => void;
  phone: boolean;
  github: string | null;
  spaceSlug: string;
  via: Map<string, WikiDocViaEntry>;
}) {
  const navigate = useNavigate();
  const mark = wikiSentenceMark(sentence);
  const lit = open?.at === at;
  const words = wikiSentenceSegments(sentence.text).map((segment, i) =>
    segment.kind === 'code' ? (
      <code key={i}>{segment.text}</code>
    ) : segment.kind === 'strong' ? (
      <strong key={i}>{segment.text}</strong>
    ) : (
      <Fragment key={i}>{segment.text}</Fragment>
    ),
  );
  const note = mark ? wikiMarkNote(sentence, section, doc) : null;
  const explained: ReactNode = note ? (
    <div className="wk-dc-tip">
      <b>{note.title}</b> {note.text}
      {note.see !== null && (
        <>
          {' '}
          <button type="button" className="lk" onClick={() => setOpen({ at, n: note.see! })}>
            {wikiSeeFootnote(note.see)}
          </button>
        </>
      )}
      {phone && note.entryId && (
        <div>
          <button type="button" className="lk" onClick={() => navigate(wikiEntryPath(spaceSlug, note.entryId!))}>
            {WIKI_OPEN_THE_ENTRY}
          </button>
        </div>
      )}
    </div>
  ) : null;
  const text = mark ? (
    <Tooltip content={explained} toggleOnClick side="bottom" align="start" popupClassName="wk-dc-tip-pop">
      <span className={MARK_CLASS[mark]} data-mark={mark} tabIndex={0}>
        {words}
      </span>
    </Tooltip>
  ) : (
    <span className={lit ? 'hl' : undefined}>{words}</span>
  );
  return (
    <>
      {text}
      {sentence.notes.length > 0 && (
        <sup className="wk-fn">
          {sentence.notes.map((n, i) => {
            const footnote = notes.get(n);
            const failed = footnote ? footnote.verdict !== 'verified' : false;
            const on = lit && open?.n === n;
            const marker = (
              <button
                type="button"
                id={i === 0 ? `wk-fnref-${n}` : undefined}
                className={`wk-fn-n${on ? ' on' : ''}${failed ? ' x' : ''}`}
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
                <WikiDocFootnoteCard note={footnote} via={via} github={github} spaceSlug={spaceSlug} docSlug={doc.slug} />
              </Popover>
            );
          })}
        </sup>
      )}
      {mark && <span className={`wk-s-lab ${LAB_CLASS[mark]}`}>{WIKI_MARK_LABELS[mark]}</span>}{' '}
    </>
  );
}

/** The icon a footnote's kind wears: a page for a design doc, brackets for code, a bubble for a session. */
function footnoteIcon(note: Pick<WikiDocFootnoteView, 'kind'>): ReactNode {
  switch (note.kind) {
    case 'design_doc':
    case 'contract':
      return <FileTextOutlined />;
    case 'code':
      return <CodeOutlined />;
    case 'turn':
    case 'event':
    case 'tool_call':
      return <MessageOutlined />;
    case 'task_comment':
      return <CommentOutlined />;
    default:
      return <ProfileOutlined />;
  }
}

/** A footnote's link, internal or out to the repository's host. */
function OpenLink({ open, className, children }: { open: WikiFootnoteOpen; className?: string; children: ReactNode }) {
  return open.external ? (
    <a className={className} href={open.href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <Link className={className} to={open.href}>
      {children}
    </Link>
  );
}

/**
 * A footnote's card (mock 23 ⑥ and its strip): the number, the kind of original and whose words, whether
 * the quote checked; the words, or the lines with the quoted one lit; what went wrong, if something did;
 * where the original is, and the way to it; and the entry it came through. On a phone it is the sheet,
 * and its one button opens the original.
 *
 * A VISITOR's card (a public wiki link, share-links §10) has no way to the original and no entry — the
 * note it is handed names none — so it says no more than the verdict about a quote that did not check
 * (the owner's line says to open the original), and a person's comment is the Owner's, never "yours".
 */
export function WikiDocFootnoteCard({
  note,
  via,
  github,
  spaceSlug,
  docSlug,
  sheet = false,
  visitor = false,
}: {
  note: WikiDocFootnoteView;
  via: Map<string, WikiDocViaEntry>;
  github: string | null;
  spaceSlug: string;
  /** The document it is a footnote of: its entry's drawer opens over it. */
  docSlug: string;
  sheet?: boolean;
  visitor?: boolean;
}) {
  const navigate = useNavigate();
  const sub = visitor && note.kind === 'task_comment' && note.label === 'USER' ? WIKI_OWNER_COMMENT : wikiFootnoteSubLabel(note);
  const open = wikiFootnoteOpen(note, github);
  const problem = visitor ? null : wikiFootnoteProblem(note);
  const entry = note.viaEntryId ? (via.get(note.viaEntryId) ?? null) : null;
  const code = note.kind !== 'design_doc' && wikiFootnoteIsRepo(note) && note.excerpt ? wikiExcerptLines(note, sheet ? WIKI_EXCERPT_LINES_PHONE : WIKI_EXCERPT_LINES) : null;
  const ok = note.verdict === 'verified';

  return (
    <div className={`wk-fn2${sheet ? ' sheet' : ''}`}>
      <div className="k">
        <span className="num">[{note.n}]</span>
        <span className="ic">{footnoteIcon(note)}</span>
        <span>{WIKI_FOOTNOTE_KIND_LABELS[note.kind]}</span>
        {sub && <span className="dim">· {sub}</span>}
        <span className={`ver${ok ? '' : ' x'}`}>{WIKI_VERDICT_CARD[note.verdict]}</span>
      </div>
      {code ? (
        <div className="code">
          {code.lines.map((line) => (
            <div className={`ln${line.quoted ? ' q' : ''}`} key={line.n}>
              <span className="i">{line.n}</span>
              <span className="c">{line.text}</span>
            </div>
          ))}
          {code.more > 0 && (
            <div className="ln cut">
              <span className="i" />
              <span className="c">{wikiMoreLines(code.more)}</span>
            </div>
          )}
        </div>
      ) : note.quote ? (
        <div className={`olc-quote${note.verdict === 'not_found' ? ' x' : ''}`}>
          <span className="wk-quote-text">{wikiQuoted(note.quote)}</span>
        </div>
      ) : null}
      {problem && <div className="xnote">{problem}</div>}
      <div className="loc">
        <span className="ic">{footnoteIcon(note)}</span>
        <span className="tx">
          <span className={wikiFootnoteIsRepo(note) ? 'mono' : undefined}>{wikiFootnotePlace(note)}</span>
          {!sheet && open && (
            <>
              {' · '}
              <OpenLink open={open}>{wikiFootnoteOpenInline(open)}</OpenLink>
            </>
          )}
        </span>
      </div>
      {entry && (
        <div className="via">
          <span className="lb">{WIKI_VIA_ENTRY}</span>
          <WikiKindMark kind={entry.kind} className="wk-kind sm" />
          <Link className="t" to={wikiEntryPath(spaceSlug, entry.id)} state={{ wikiBack: { doc: docSlug } }}>
            {entry.title}
          </Link>
          <WikiTrustBadge trust={entry.trust as WikiTrust} />
        </div>
      )}
      {sheet && open && (open.external ? (
        <LinkButton variant="primary" size="large" className="wk-fncard-open" href={open.href} target="_blank">
          {open.label}
        </LinkButton>
      ) : (
        <Button variant="primary" size="large" className="wk-fncard-open" onClick={() => navigate(open.href)}>
          {open.label}
        </Button>
      ))}
    </div>
  );
}

/** The footnotes under the text (mock 23 ⑦): number, kind, where, the check; the words; what they came through. */
export function WikiDocFootnoteList({
  doc,
  via,
  lit,
  onOpen,
}: {
  doc: Pick<WikiDocView, 'footnotes'>;
  via: Map<string, WikiDocViaEntry>;
  lit: number | null;
  onOpen: (n: number) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? doc.footnotes : doc.footnotes.slice(0, WIKI_FOOTNOTES_SHOWN);
  const hidden = doc.footnotes.length - shown.length;
  return (
    <section className="wk-fn2-list">
      <h3>
        {WIKI_DOC_FOOTNOTES} <small>{wikiFootnotesSummary(doc.footnotes)}</small>
      </h3>
      {shown.map((note) => {
        const entry = note.viaEntryId ? via.get(note.viaEntryId) : undefined;
        const status = entry ? wikiViaEntryStatus(entry) : null;
        const session = note.kind === 'turn' || note.kind === 'event' || note.kind === 'tool_call';
        return (
          <div className={`wk-fn2-row${lit === note.n ? ' on' : ''}`} key={note.n}>
            <span className="no">{note.n}.</span>
            <div className="main">
              <div className="l1">
                <span className={`kd${session ? ' s' : ''}`}>
                  {footnoteIcon(note)}
                  {WIKI_FOOTNOTE_KIND_LABELS[note.kind]}
                </span>
                <button type="button" className={`loc${wikiFootnoteIsRepo(note) ? ' mono' : ''}`} onClick={() => onOpen(note.n)}>
                  {wikiFootnoteWhere(note)}
                </button>
                <span className={`ver${note.verdict === 'verified' ? '' : ' x'}`}>{WIKI_VERDICT_LIST[note.verdict]}</span>
              </div>
              <div className={`q${note.verdict === 'not_found' ? ' x' : ''}`}>{note.quote ? wikiQuoted(note.quote) : WIKI_NO_QUOTE_GIVEN}</div>
              {entry && (
                <div className="via">
                  via <b>{entry.title}</b>
                  {status ? ` · ${status}` : ''}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="wk-more" onClick={() => setAll(true)}>
          {wikiShowMore(hidden)}
        </button>
      )}
    </section>
  );
}

/** The entries its quotes came through (mock 23 ⑧), by kind, each with the footnotes it carried. */
function WikiDocEntries({
  doc,
  spaceSlug,
  byId,
  phone,
}: {
  doc: WikiDocView;
  spaceSlug: string;
  byId: Map<string, WikiEntry>;
  phone: boolean;
}) {
  const groups = useMemo(() => wikiDocEntryGroups(doc.entries), [doc.entries]);
  const summaries = useMemo(() => wikiEntrySummaries([...byId.values()]), [byId]);
  return (
    <section className="wk-art-entries wk-dc-entries">
      <h3 className="wk-art-entries-h">
        {WIKI_DOC_ENTRIES} <small>{wikiDocEntriesHint(doc.entries.length)}</small>
      </h3>
      {groups.map((group) => (
        <WikiDocEntryGroup
          key={group.title}
          group={group}
          doc={doc}
          spaceSlug={spaceSlug}
          byId={byId}
          summaries={summaries}
          shownFirst={phone ? WIKI_DOC_GROUP_SHOWN_PHONE : WIKI_DOC_GROUP_SHOWN}
        />
      ))}
    </section>
  );
}

function WikiDocEntryGroup({
  group,
  doc,
  spaceSlug,
  byId,
  summaries,
  shownFirst,
}: {
  group: { title: string; note: string; entries: WikiDocViaEntry[] };
  doc: WikiDocView;
  spaceSlug: string;
  byId: Map<string, WikiEntry>;
  summaries: Map<string, string>;
  shownFirst: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.entries : group.entries.slice(0, shownFirst);
  const hidden = group.entries.length - shown.length;
  return (
    <div className="wk-sec">
      <div className="wk-sec-h">
        <h3>{group.title}</h3>
        <span className="n">{group.entries.length}</span>
        <span className="note">{group.note}</span>
        <span className="cols">
          <span className="col">{WIKI_COL_CONFIRMED_BY}</span>
          <span className="col">{WIKI_COL_ANCHOR}</span>
          <span className="col">{WIKI_COL_THIS_WEEK}</span>
        </span>
      </div>
      {shown.map((entry) => {
        const full = byId.get(entry.id);
        const gone = entry.status === 'rejected' || entry.status === 'retired' || entry.status === 'superseded';
        const line = gone ? wikiViaEntryNote(entry, doc) : (summaries.get(entry.id) ?? null);
        const mark = wikiAnchorMark(full ?? { anchorState: entry.anchorState, anchorCheckedRef: null });
        return (
          <div className={`wk-erow${gone ? ' sup' : ''}`} key={entry.id}>
            <WikiKindMark kind={entry.kind} />
            <div className="main">
              <div className="wk-row-t">
                <span className="tt">
                  <Link to={wikiEntryPath(spaceSlug, entry.id)} state={{ wikiBack: { doc: doc.slug } }}>
                    {entry.title}
                  </Link>
                </span>
                <span className="wk-dc-refs">{entry.notes.map((n) => `[${n}]`).join('')}</span>
              </div>
              {line && <div className={gone ? 'supby' : 'wk-row-d'}>{line}</div>}
            </div>
            <span>{gone ? <WikiStatusBadge status={entry.status} /> : <WikiTrustBadge trust={entry.trust as WikiTrust} />}</span>
            <span>
              <WikiAnchorMark mark={mark} />
            </span>
            <span className="used" />
          </div>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="wk-more" onClick={() => setAll(true)}>
          {wikiShowMore(hidden)}
        </button>
      )}
    </div>
  );
}
