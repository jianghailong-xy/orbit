import { createContext, useContext, useState, type ReactNode, type RefObject } from 'react';
import { App, Button, Input, Select } from 'antd';
import {
  BookOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { KIND_SPECS, WIKI_LIMITS, type WikiKind, type WikiSourceInput } from '@orbit/shared';
import { copyText } from '../lib/clipboard';
import { wikiSpaceForSessionQuery } from '../lib/queries';
import { WIKI_KIND_LABELS } from '../lib/wiki';
import { proposeToWiki, useWikiWrite, wikiIdempotencyKey } from '../lib/wikiWrites';
import { SchemaInput, WIKI_AUTHORED_KINDS } from './WikiNewEntry';

/**
 * Add to Wiki: recording what a message says, from the message.
 *
 * The owner reading their own conversation is where most of a wiki's entries come from (design
 * §8.1) — a rule they stated mid-sentence, a decision they made out loud. The write is the owner's
 * own door (`POST /wiki/spaces/:id/changesets`), which is what makes it apply at once and carry
 * `trust: owner` rather than waiting in Review, and the provenance is the turn the message belongs
 * to: an entry that cannot say where it came from is the one thing phase 1 refuses to store.
 *
 * WHAT IT OFFERS, AND WHY NOT EVERYTHING. The kinds here are the ones a form can write — a
 * principle, a convention, a concept — because those are the kinds whose required fields are
 * sentences an owner types out. A decision needs its rejected alternatives, a pitfall the run that
 * hit it, a recipe the command that proves it, and a form cannot ask for any of those without
 * pretending it knows them: they are what `wiki_propose` is for, from the session that was there
 * (design §8.1). `WikiNewEntry` draws the same line from the other direction.
 *
 * WHERE IT IS DRAWN. Only inside a conversation that is somebody's own — the context below is
 * mounted by `WorkspaceView` and by nothing else, so the shared page and the static export draw no
 * such row. A visitor following a public link is not signed in and cannot write, and a button that
 * refused when pressed would be worse than no button at all.
 */

/** The conversation a message belongs to: which codebase's wiki it files into. */
export interface WikiConversation {
  sessionId: string;
  /** The session's title, as the row under the form's Source line says it. */
  title: string;
}

export const AddToWikiCtx = createContext<WikiConversation | null>(null);

/**
 * The text a person has selected inside one message, or empty.
 *
 * Scoped to the message the button was pressed on: a selection somewhere else on the page is not
 * this message's, and prefilling the form with it would file a note against words the person was
 * not looking at. The selection is still live when the click lands because the button refuses the
 * mousedown that would collapse it (`AddToWikiRow`).
 */
export function selectionWithin(el: HTMLElement | null): string {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  if (el && !el.contains(range.commonAncestorContainer)) return '';
  return selection.toString().trim();
}

/**
 * The title a selection suggests: its first sentence, without the full stop.
 *
 * A suggestion and not a rule — the field stays editable, and the owner is the one who names it. An
 * empty answer is a real one: a selection with no sentence ending in it (a code snippet, half a
 * clause) leaves the field for the person to fill rather than cutting a sentence in half.
 */
export function titleFromSelection(selection: string): string {
  // Up to and including the FIRST sentence ending, whatever follows it: Chinese writes one with no
  // space after the full stop, so requiring whitespace would carry a whole paragraph into the title.
  const first = /^[\s\S]*?[.!?。！？]/u.exec(selection.trim())?.[0] ?? '';
  const title = first.replace(/[.!?。！？]$/u, '').trim();
  return title.length > 0 && title.length <= WIKI_LIMITS.titleMaxChars ? title : '';
}

export const ADD_TO_WIKI = 'Add to Wiki';
export const ADD_TO_WIKI_SOURCE = 'This message';
export const ADD_TO_WIKI_OWNER_NOTE = 'Written by you — live at once';

/**
 * Add to Wiki's two halves and the state between them.
 *
 * Returned APART on purpose: the button belongs in the message's row of actions, and the form
 * belongs under that row with a line of its own — a flex row that had both would set the form's
 * 452px beside the copy button. So the caller places them, and this holds what they share.
 *
 * `turnId` is the citation the entry will carry, null on an event that never named one. The entry
 * is then recorded with no source rather than with a guessed one, which the owner's own door
 * permits (`requiresSource` returns false for an owner's ops) — a degradation, not a refusal.
 */
export function useAddToWiki({
  turnId,
  messageRef,
}: {
  turnId: string | null;
  /** The message's element, read when the button is pressed rather than passed in: an element
   *  captured during a render is null on the render that draws the button. */
  messageRef: RefObject<HTMLElement | null>;
}): { button: ReactNode; form: ReactNode } {
  const conversation = useContext(AddToWikiCtx);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState('');
  if (!conversation) return { button: null, form: null };
  const toggle = (): void => {
    const next = !open;
    setSelection(next ? selectionWithin(messageRef.current) : '');
    setOpen(next);
  };
  return {
    button: (
      <button
        type="button"
        className="wk-addwiki"
        // The press that would collapse the selection is refused here, so the click that follows
        // still finds it (`selectionWithin`). Without this the prefill is always empty.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        aria-expanded={open}
      >
        <BookOutlined className="ic" />
        {ADD_TO_WIKI}
      </button>
    ),
    form: open ? (
      <AddToWikiForm
        conversation={conversation}
        turnId={turnId}
        selection={selection}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
}

/**
 * A reply's row: the copy button a user bubble already has, then Add to Wiki, then the time — the
 * row the user bubble has had all along, drawn on the other side.
 */
export function AddToWikiRow({
  text,
  turnId,
  messageRef,
  time,
}: {
  /** The reply's own text, which the copy button hands back. */
  text: string;
  turnId: string | null;
  messageRef: RefObject<HTMLElement | null>;
  /** The relative time beside the button, already worded by the transcript's own `relTime`. */
  time: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const add = useAddToWiki({ turnId, messageRef });
  const copy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <>
      <div className="wk-msg-meta">
        <button
          type="button"
          className="chat-copy"
          onClick={copy}
          title={copied ? 'Copied' : 'Copy message'}
          aria-label={copied ? 'Copied' : 'Copy message'}
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </button>
        {add.button}
        {time && <span className="chat-time">{time}</span>}
      </div>
      {add.form}
    </>
  );
}

/** The form, anchored under the row it was opened from. */
function AddToWikiForm({
  conversation,
  turnId,
  selection,
  onClose,
}: {
  conversation: WikiConversation;
  turnId: string | null;
  selection: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<WikiKind>(WIKI_AUTHORED_KINDS[0]);
  const [title, setTitle] = useState(() => titleFromSelection(selection));
  const [summary, setSummary] = useState(() => selection.slice(0, WIKI_LIMITS.summaryMaxChars));
  const [topics, setTopics] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const { message } = App.useApp();

  // Which space this conversation's codebase is: the server's own rule, asked once when the form
  // opens (`wikiSpaceForSessionQuery`). Nothing is filed until it answers — an owner with two
  // codebases has no way to tell from here which one a session works in.
  const space = useQuery(wikiSpaceForSessionQuery(conversation.sessionId));
  const write = useWikiWrite((spaceId: string) =>
    proposeToWiki(spaceId, {
      rationale: `the owner records a ${kind} from a conversation`,
      idempotencyKey: wikiIdempotencyKey('wiki-add'),
      ops: [
        {
          op: 'add',
          entry: { kind, title: title.trim(), summary: summary.trim(), topics, fields } as never,
          // The turn this message belongs to, and nothing else: the record is what makes this a
          // memory rather than an assertion, and the words themselves are already in the entry.
          sources: turnId ? [{ kind: 'turn', ref: turnId } satisfies WikiSourceInput] : [],
        },
      ],
    }),
  );

  const submit = async () => {
    const spaceId = space.data?.id;
    if (!spaceId) return;
    try {
      await write.mutateAsync(spaceId);
      message.success('Recorded');
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'The server refused it');
    }
  };

  const spec = KIND_SPECS[kind];
  const ready = title.trim() !== '' && summary.trim() !== '' && space.data !== undefined;

  return (
    <div className="wk-pop">
      <div className="wk-pop-h">
        <BookOutlined className="ic b" />
        {ADD_TO_WIKI}
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <CloseOutlined />
        </button>
      </div>
      <div className="wk-form">
        <label className="k">Kind</label>
        <Select
          value={kind}
          onChange={(next) => {
            setKind(next);
            setFields({});
          }}
          options={WIKI_AUTHORED_KINDS.map((k) => ({ value: k, label: WIKI_KIND_LABELS[k] }))}
        />
        <label className="k">Title</label>
        <Input
          value={title}
          maxLength={WIKI_LIMITS.titleMaxChars}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="k top">Summary</label>
        <Input.TextArea
          rows={3}
          value={summary}
          maxLength={WIKI_LIMITS.summaryMaxChars}
          onChange={(event) => setSummary(event.target.value)}
        />
        <label className="k">Topic</label>
        {/* Typed, not picked from a list: a topic is a slug the owner writes, and reading a space's
            entries to offer the ones already in use would fetch two hundred rows to fill a menu. */}
        <Select
          mode="tags"
          value={topics}
          maxCount={WIKI_LIMITS.topicsMax}
          placeholder="One or two topics"
          open={false}
          onChange={setTopics}
        />
        {Object.entries(spec.fields).map(([name, schema]) => (
          <SchemaInput
            key={name}
            name={name}
            schema={schema}
            value={fields[name]}
            onChange={(value) => setFields((previous) => ({ ...previous, [name]: value }))}
          />
        ))}
        <label className="k">Source</label>
        <span className="wk-src-auto">
          <MessageOutlined className="ic" />
          <span className="t">{`${ADD_TO_WIKI_SOURCE} · ${conversation.title}`}</span>
        </span>
      </div>
      {space.isError && (
        <div className="wk-pop-foot">
          <span className="note warn">
            {space.error instanceof Error ? space.error.message : 'This codebase has no wiki space.'}
          </span>
        </div>
      )}
      <div className="wk-pop-foot">
        <span className="note">
          <span className="tdp-badge tone-owner">Owner</span>
          {ADD_TO_WIKI_OWNER_NOTE}
        </span>
        <Button size="small" onClick={onClose}>
          Cancel
        </Button>
        <Button size="small" type="primary" disabled={!ready} loading={write.isPending} onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}
