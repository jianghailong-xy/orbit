import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  ExclamationCircleFilled,
  SyncOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { WikiSeeChanges } from './WikiSeeChanges';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { wikiChatDraftQuery, wikiSpacesQuery } from '../lib/queries';
import { wikiEntryPath } from '../lib/wiki';
import { wikiDocSectionPath } from '../lib/wikiDocs';
import { wikiPlanDocPath, wikiPlanPath } from '../lib/wikiPlan';
import { wikiSettingsPath } from '../lib/wikiReviewMode';
import {
  WIKI_CHAT_ACTION_PRESS,
  WIKI_CHAT_CARD_UNREAD,
  WIKI_CHAT_CANCEL,
  WIKI_CHAT_EDIT_LINE,
  WIKI_CHAT_EDIT_NOTE,
  WIKI_CHAT_EDIT_TITLE,
  WIKI_CHAT_EDIT_TITLE_FIELD,
  WIKI_CHAT_REDO_MESSAGE,
  WIKI_CHAT_REWRITES,
  WIKI_CHAT_SIMILAR,
  WIKI_CHAT_SOURCES,
  WIKI_CHAT_WEB,
  WIKI_CHAT_WEB_NOTE,
  WIKI_CHAT_PARAM,
  pressWikiChatDraft,
  sendWikiChatTurn,
  wikiChatActionLabel,
  wikiChatCardFace,
  wikiChatCardLook,
  wikiChatInReviewOp,
  wikiChatNeedsSeen,
  wikiChatPressDetails,
  wikiChatPressError,
  wikiChatResultLook,
  wikiChatRewritesRow,
  wikiReviewItemAnchor,
  type WikiChatAction,
  type WikiChatDraftOpView,
  type WikiChatDraftView,
  type WikiChatPress,
  type WikiChatPressAnswer,
} from '../lib/wikiChat';

/**
 * What drawing a card needs of the place it is drawn in: the panel beside the wiki, or the full session page of the
 * chat. Null wherever no card is drawn — a share link, an export, any session that is no chat — and a drafting call
 * there is drawn as any tool call (contract `chat.drafts.toolResult`).
 */
export interface WikiDraftCardHost {
  /** The chat's space, whose documents the card's sections are. */
  spaceId: string;
  /** Opens a section beside the chat (the panel) or in the wiki with the chat beside it (the session page). */
  openSection: (doc: string, key: string) => void;
  openEntry: (entryId: string) => void;
  /** The entry's item in Review, for an applied card whose challenge waits there. */
  openReview: (changesetId: string | null, seq: number | null) => void;
  openSettings: () => void;
  /** The plan page — at a plan card's document, when it names one. */
  openPlan: (docSlug?: string) => void;
  /** The owner's next message in this chat: Redo sends the contract's sentence (`chat.drafts.states.changed`). */
  send: (text: string) => Promise<void>;
  /** The card the round button or Activity opened the chat at: it scrolls itself into view. */
  focus: string | null;
}

export const WikiDraftCardCtx = createContext<WikiDraftCardHost | null>(null);

export const useWikiDraftCardHost = (): WikiDraftCardHost | null => useContext(WikiDraftCardCtx);

/** Where an In Review card's note goes: the space's Review, at the op when the card knows which. */
export function wikiChatReviewPath(spaceSlug: string, changesetId: string | null, seq: number | null): string {
  const base = `/wiki/${spaceSlug}/review`;
  return changesetId && seq !== null ? `${base}#${wikiReviewItemAnchor(changesetId, seq)}` : base;
}

/**
 * The card host of a chat's full session page (design §7.1: the same card as in the panel). What a card opens, it opens
 * in the space's wiki with this chat beside it (`?chat=`): a section on its document, an entry in its drawer, Review,
 * Settings, the plan. Redo goes through the chat's own message door, as the panel's composer sends. Null for a session
 * that is no chat, and until the space's slug is known.
 */
export function useWikiChatSessionCards(sessionId: string | null, spaceId: string | null | undefined): WikiDraftCardHost | null {
  const navigate = useNavigate();
  const spaces = useQuery({ ...wikiSpacesQuery(), enabled: !!sessionId && !!spaceId });
  const slug = spaces.data?.find((row) => row.id === spaceId)?.slug ?? null;
  return useMemo(() => {
    if (!sessionId || !spaceId || !slug) return null;
    const chat = `${WIKI_CHAT_PARAM}=${encodeURIComponent(sessionId)}`;
    const beside = (path: string) => {
      const [route, hash] = path.split('#');
      navigate(`${route}${route!.includes('?') ? '&' : '?'}${chat}${hash ? `#${hash}` : ''}`);
    };
    return {
      spaceId,
      openSection: (doc, key) => beside(wikiDocSectionPath(slug, doc, key)),
      openEntry: (entryId) => beside(wikiEntryPath(slug, entryId)),
      openReview: (changesetId, seq) => beside(wikiChatReviewPath(slug, changesetId, seq)),
      openSettings: () => navigate(wikiSettingsPath(slug)),
      openPlan: (docSlug) => beside(docSlug ? wikiPlanDocPath(slug, docSlug) : wikiPlanPath(slug)),
      send: async (text) => {
        await sendWikiChatTurn(sessionId, text, undefined);
      },
      focus: null,
    };
  }, [navigate, sessionId, spaceId, slug]);
}

/**
 * A wiki chat's card (design §7, board 42 ② ③ ④), drawn from the id its drafting call answered: its state, its words and
 * what it offers are the server's read of it (`GET /api/wiki/chat-drafts/:id`), so the panel and the full session page
 * draw the same card, and a press anywhere moves both.
 *
 * AN OPEN CARD SAYS WHAT IT WOULD DO before it is pressed: its entry's words or an amend's red and green lines, the
 * agent's why, its sources, the sections its press would rewrite — each opens beside the chat — and the entries it may
 * duplicate. A settled card is quiet: its status, what it was about, Undo and Open entry. An applied card's rewrite
 * stands under it as one line (design §8.3), with Settings, Try again or See changes; See changes opens the sentence by
 * sentence comparison of each section it wrote, and opening a settled rewrite tells the server it was seen.
 */
export function WikiDraftCard({ draftId }: { draftId: string }) {
  const host = useWikiDraftCardHost();
  const read = useQuery(wikiChatDraftQuery(draftId));
  const view = read.data ?? null;
  if (read.isError && !view) {
    return (
      <div className="wk-draft" data-draft={draftId}>
        <div className="wk-draft-card quiet">
          <div className="wk-draft-none">{WIKI_CHAT_CARD_UNREAD}</div>
        </div>
      </div>
    );
  }
  if (!view || !host) return <div className="wk-draft" data-draft={draftId} aria-busy="true" />;
  return <WikiDraftCardView view={view} host={host} />;
}

function WikiDraftCardView({ view, host }: { view: WikiChatDraftView; host: WikiDraftCardHost }) {
  const qc = useQueryClient();
  const look = wikiChatCardLook(view);
  const face = wikiChatCardFace(view);
  const result = wikiChatResultLook(view);
  const open = view.state === 'draft' || view.state === 'changed';
  const [busy, setBusy] = useState<WikiChatAction | null>(null);
  // A press refused: the server's reason, and — a plan card's change the plan's gate refused — every error it found.
  const [failed, setFailed] = useState<{ line: string; details: string[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [seeing, setSeeing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const seenSent = useRef(false);

  const press = async (kind: WikiChatPress, body?: Record<string, unknown>): Promise<WikiChatPressAnswer> => {
    const answer = await pressWikiChatDraft(view.id, kind, body);
    qc.setQueryData(wikiChatDraftQuery(view.id).queryKey, answer.draft);
    // A press moves the chats list's counts, the space's waiting count and the page beside the chat.
    void qc.invalidateQueries({ queryKey: ['wiki'] });
    return answer;
  };

  // A settled rewrite the owner has opened is seen, once (contract `chat.presses.seen`): the card on screen, or See changes.
  const markSeen = () => {
    if (seenSent.current || !wikiChatNeedsSeen(view)) return;
    seenSent.current = true;
    void press('seen').catch(() => {
      seenSent.current = false;
    });
  };
  const needsSeen = wikiChatNeedsSeen(view);
  useEffect(() => {
    if (!needsSeen) return;
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      markSeen();
      return;
    }
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) {
        observer.disconnect();
        markSeen();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
    // markSeen reads the view it was made with; the effect runs again when the card's read moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsSeen, view.id]);

  // Opened at this card (the round button, Activity's banner): the host brings it into view, and it wears the ring.
  const focused = host.focus === view.id;

  const act = async (action: WikiChatAction) => {
    setFailed(null);
    if (action === 'edit') return setEditing(true);
    if (action === 'see_changes') {
      setSeeing((shown) => !shown);
      markSeen();
      return;
    }
    if (action === 'open_entry') {
      const entryId = view.ops.find((op) => op.entryId)?.entryId;
      if (entryId) host.openEntry(entryId);
      return;
    }
    if (action === 'settings') return host.openSettings();
    // A plan card opens its first document on the plan page (C17: a card may change several).
    if (action === 'open_in_plan') return host.openPlan(view.change?.docs[0]?.slug);
    setBusy(action);
    try {
      if (action === 'redo') await host.send(WIKI_CHAT_REDO_MESSAGE);
      else {
        const kind = WIKI_CHAT_ACTION_PRESS[action];
        if (kind) await press(kind);
      }
    } catch (error) {
      setFailed({ line: wikiChatPressError(error), details: wikiChatPressDetails(error) });
    } finally {
      setBusy(null);
    }
  };

  const inReviewOp = wikiChatInReviewOp(view);
  const primary = open && view.state === 'draft' ? look.actions[0] : null;
  const sections = view.rewrite?.sections ?? [];

  return (
    <div className="wk-draft" data-draft={view.id} data-state={view.state} ref={rootRef} id={`wk-draft-${view.id}`}>
      <div className={`wk-draft-card${look.quiet ? ' quiet' : ''}${focused ? ' focus' : ''}`}>
        <div className={`wk-draft-k ${look.tone}`}>
          {view.state === 'applied' && !look.inReview && <CheckOutlined className="ic" />}
          <span>{look.title}</span>
        </div>
        {look.note &&
          (look.inReview ? (
            <button
              type="button"
              className="wk-draft-note lk"
              onClick={() => host.openReview(view.changesetId, inReviewOp?.seq ?? null)}
            >
              {look.note}
            </button>
          ) : (
            <div className="wk-draft-note">{look.note}</div>
          ))}
        {view.tainted && (
          <div className="wk-draft-web">
            <ExclamationCircleFilled className="ic" />
            <b>{WIKI_CHAT_WEB}</b> · {WIKI_CHAT_WEB_NOTE}
          </div>
        )}
        {face.heading && <div className={`wk-draft-ti${open ? '' : ' settled'}`}>{face.heading}</div>}
        {open && (face.diff.length > 0 || face.rows.length > 0 || face.sources.length > 0 || view.rewrites.length > 0) && (
          <div className="wk-draft-body">
            {face.diff.length > 0 && (
              <div className="wk-draft-diff">
                {face.diff.map((line, index) => (
                  <div key={index} className={line.sign === '+' ? 'wk-see-ins' : 'wk-see-del'}>
                    {line.text}
                  </div>
                ))}
              </div>
            )}
            <div className="wk-draft-kv">
              {face.rows.map((row) => (
                <FaceRow key={`${row.label}:${row.value}`} label={row.label}>
                  {row.value}
                </FaceRow>
              ))}
              {face.sources.length > 0 && (
                <FaceRow label={WIKI_CHAT_SOURCES}>
                  {face.sources.map((source) => (
                    <span key={source} className="wk-draft-src">
                      <CheckOutlined className="okm" /> {source}
                    </span>
                  ))}
                </FaceRow>
              )}
              {view.rewrites.length > 0 && (
                <FaceRow label={WIKI_CHAT_REWRITES}>
                  {wikiChatRewritesRow(view).map((link, index) => (
                    <span key={`${link.doc}#${link.key}`}>
                      {index > 0 && ' · '}
                      <button
                        type="button"
                        className="lk"
                        title={link.title ?? undefined}
                        onClick={() => host.openSection(link.doc, link.key)}
                      >
                        {link.label}
                      </button>
                    </span>
                  ))}
                </FaceRow>
              )}
              {view.state === 'draft' && view.similar.length > 0 && (
                <FaceRow label={WIKI_CHAT_SIMILAR}>
                  {view.similar.slice(0, 3).map((similar, index) => (
                    <span key={similar.id}>
                      {index > 0 && ' · '}
                      <button type="button" className="lk" onClick={() => host.openEntry(similar.id)}>
                        {similar.title}
                      </button>
                    </span>
                  ))}
                </FaceRow>
              )}
            </div>
          </div>
        )}
        {look.actions.length > 0 && (
          <div className="wk-draft-acts">
            {look.actions.map((action) => (
              <Button
                key={action}
                size="small"
                variant={action === primary ? 'primary' : 'default'}
                icon={action === 'undo' ? <UndoOutlined /> : undefined}
                loading={busy === action}
                disabled={busy !== null && busy !== action}
                onClick={() => void act(action)}
              >
                {wikiChatActionLabel(action)}
              </Button>
            ))}
          </div>
        )}
        {failed && (
          <div className="wk-draft-failed" role="alert">
            {failed.line}
            {failed.details.length > 0 && (
              <ul className="wk-draft-failed-list">
                {failed.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {result && (
        <div className={`wk-draft-result ${result.tone}`} data-result={view.rewrite!.result} data-waits={result.waits || undefined}>
          <span className="ic">{RESULT_ICON[result.tone]}</span>
          <span className="t">{result.line}</span>
          {look.rewriteActions.map((action) => (
            <Button
              key={action}
              size="small"
              variant={action === 'see_changes' ? 'link' : 'default'}
              loading={busy === action}
              disabled={busy !== null && busy !== action}
              aria-expanded={action === 'see_changes' ? seeing : undefined}
              onClick={() => void act(action)}
            >
              {wikiChatActionLabel(action)}
            </Button>
          ))}
        </div>
      )}
      {seeing && (
        <div className="wk-draft-card quiet wk-draft-see">
          {sections
            .filter((section) => section.result === 'updated' || section.result === 'same')
            .map((section) => (
              <WikiSeeChanges
                key={`${section.doc}#${section.key}`}
                spaceId={host.spaceId}
                doc={section.doc}
                sectionKey={section.key}
                where={section.where}
                versionId={section.versionId}
                unchanged={section.result === 'same'}
              />
            ))}
        </div>
      )}
      {editing && (
        <WikiDraftEditor
          view={view}
          onApply={(body) => press('edit', body)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

const RESULT_ICON = {
  run: <SyncOutlined spin />,
  ok: <CheckCircleFilled />,
  amber: <ExclamationCircleFilled />,
  error: <CloseCircleFilled />,
  grey: <ClockCircleOutlined />,
} as const;

function FaceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="l">{label}</span>
      <span className="v">{children}</span>
    </>
  );
}

/** The two lines an op leaves its entry with, as Edit opens on them: an add's own draft, or an amend's over its entry. */
function opWords(op: WikiChatDraftOpView): { title: string; summary: string } {
  const over = (op.payload.entry ?? op.payload.changes ?? {}) as Record<string, unknown>;
  const entry = (op.entry ?? {}) as Record<string, unknown>;
  const pick = (key: 'title' | 'summary') => (typeof over[key] === 'string' ? (over[key] as string) : typeof entry[key] === 'string' ? (entry[key] as string) : '');
  return { title: pick('title'), summary: pick('summary') };
}

/**
 * Edit (design §7.2, as Review's Edit): the owner's version of each add, supersede and amend the card holds — its title
 * and one line — applied as theirs in one press. Only what changed is sent; with nothing changed the button waits, since
 * that would be Apply. A refusal stays in the dialog, with the text it is about.
 */
function WikiDraftEditor({
  view,
  onApply,
  onClose,
}: {
  view: WikiChatDraftView;
  onApply: (body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const editable = view.ops.filter((op) => op.op === 'add' || op.op === 'supersede' || op.op === 'amend');
  const [opened] = useState(() => new Map(editable.map((op) => [op.seq, opWords(op)])));
  const [words, setWords] = useState(() => new Map(editable.map((op) => [op.seq, opWords(op)])));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const edits = editable.flatMap((op) => {
    const was = opened.get(op.seq)!;
    const now = words.get(op.seq)!;
    const changes: Record<string, string> = {};
    if (now.title.trim() !== was.title.trim()) changes.title = now.title.trim();
    if (now.summary.trim() !== was.summary.trim()) changes.summary = now.summary.trim();
    return Object.keys(changes).length > 0 ? [{ seq: op.seq, changes }] : [];
  });
  const blank = [...words.values()].some((one) => one.title.trim().length === 0);

  const submit = async () => {
    setSaving(true);
    setRefusal(null);
    try {
      await onApply({ ops: edits });
    } catch (error) {
      setSaving(false);
      setRefusal(wikiChatPressError(error));
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      title={WIKI_CHAT_EDIT_TITLE}
      onClose={onClose}
      className="wk-proposal-dialog wk-draft-edit"
      footer={
        <>
          <Button onClick={onClose}>{WIKI_CHAT_CANCEL}</Button>
          <Button variant="primary" disabled={edits.length === 0 || blank} loading={saving} onClick={() => void submit()}>
            {wikiChatActionLabel('apply')}
          </Button>
        </>
      }
    >
      <p className="wk-modal-note">{WIKI_CHAT_EDIT_NOTE}</p>
      {editable.map((op) => {
        const now = words.get(op.seq)!;
        const set = (next: Partial<{ title: string; summary: string }>) =>
          setWords((all) => new Map(all).set(op.seq, { ...all.get(op.seq)!, ...next }));
        return (
          <div key={op.seq} className="wk-draft-edit-op" data-seq={op.seq}>
            <Input
              aria-label={WIKI_CHAT_EDIT_TITLE_FIELD}
              value={now.title}
              onChange={(event) => set({ title: event.target.value })}
              placeholder={WIKI_CHAT_EDIT_TITLE_FIELD}
            />
            <Textarea
              aria-label={WIKI_CHAT_EDIT_LINE}
              rows={3}
              value={now.summary}
              onChange={(event) => set({ summary: event.target.value })}
              placeholder={WIKI_CHAT_EDIT_LINE}
              style={{ marginTop: 8 }}
            />
          </div>
        );
      })}
      {refusal && (
        <div className="wk-draft-failed" role="alert">
          {refusal}
        </div>
      )}
    </Dialog>
  );
}
