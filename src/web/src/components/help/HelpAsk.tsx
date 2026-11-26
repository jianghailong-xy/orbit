import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpOutlined, CheckOutlined, CloseOutlined, DownOutlined, EditOutlined, ExportOutlined, FileTextOutlined, GithubOutlined, LeftOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { helpAskEngineLabel, type HelpAskChoices, type HelpAskPage, type HelpArticleMeta } from '@orbit/shared';
import { sendTurn } from '../../api';
import Markdown from '../Markdown';
import { Menu, type MenuItem } from '../ui/Menu';
import { useHelpDrawer } from '../../lib/helpDrawer';
import { forThisPage, getStartedArticles, routeLabel } from '../../lib/help/drawerArticles';
import { askAnswerId, useHelpVote } from '../../lib/help/helpFeedback';
import { helpArticlePath, helpIndexQuery } from '../../lib/help/helpQueries';
import { resolveOrbitLink } from '../../lib/help/helpContent';
import {
  askableMachines,
  askExchanges,
  askPage,
  citationOf,
  createHelpAsk,
  defaultAskPick,
  helpAskChoicesQuery,
  parseAnswer,
  suggestedQuestions,
  toolLine,
  type AskExchange,
  type AskSource,
} from '../../lib/help/helpAsk';
import { useHelpAccount } from '../../lib/help/useHelpAccount';
import {
  answerText,
  askYourAdmin,
  helpAskStuckQuery,
  REPORT_NOT_INCLUDED,
  reportBody,
  reportIssueUrl,
  reportTitle,
} from '../../lib/help/stillStuck';
import { useVisibleHelpErrors } from '../../lib/help/useVisibleHelpErrors';
import { sessionQuery } from '../../lib/queries';
import { isSessionLive, isSessionQueued, isSessionTerminal, sessionRunStatusOf } from '../../lib/sessionState';
import { useSessionStream } from '../../lib/useSessionStream';
import { useToast } from '../../lib/toast';
import { claudeModelName } from '../../lib/workspaceDefaults';
import './HelpAsk.css';

/** The three Get started articles the no-machine state offers (board 02 ③A), in this order. */
const START_HERE = ['orbit-in-five-minutes', 'add-your-first-machine', 'connect-a-model'];

/** Where "+ Add a machine" goes: Settings → Machines → Add a runner. */
export const ADD_MACHINE_PATH = '/settings/machines/new';

/**
 * The help drawer's Ask tab (docs/mocks/help-center board 02 ①–③): the Runs on picker, a new question — suggested
 * questions from the page and its errors, the page attached as a chip, Read-only — or the conversation the drawer is
 * on. With no machine that can answer, the "Ask needs a machine" state (③A). `query` is a question handed over from
 * the Articles tab's search, `article` the article its Ask instead was pressed on.
 */
export function HelpAskPane({ query, article }: { query: string | null; article: string | null }) {
  const help = useHelpDrawer();
  const choices = useQuery(helpAskChoicesQuery());
  if (help.askSession) {
    return (
      <AskConversation
        sessionId={help.askSession}
        choices={choices.data}
        onBack={() => help.setAskSession(null)}
        onOpenArticle={(slug) => help.openHelp({ slug })}
      />
    );
  }
  return <NewAsk query={query} article={article} choices={choices.data} loading={choices.isLoading} onAsked={help.setAskSession} />;
}

/** A new question: the picker, the suggestions, the composer — or why there is nowhere to ask. */
function NewAsk({
  query,
  article,
  choices,
  loading,
  onAsked,
}: {
  query: string | null;
  article: string | null;
  choices: HelpAskChoices | undefined;
  loading: boolean;
  onAsked: (sessionId: string) => void;
}) {
  const { pathname } = useLocation();
  const errors = useVisibleHelpErrors();
  const index = useQuery(helpIndexQuery());
  const articles = index.data?.articles ?? [];
  const handed = article ? articles.find((a) => a.slug === article) : undefined;
  const [pick, setPick] = useState<{ runnerId: string; engine: string } | null>(null);
  const chosen = pick ?? defaultAskPick(choices);
  const [chipOff, setChipOff] = useState(false);
  const page: HelpAskPage | null = chipOff
    ? null
    : handed
      ? askPage(helpArticlePath(handed), `Article: ${handed.title}`, [])
      : askPage(pathname, routeLabel(pathname), errors);
  const qc = useQueryClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);

  // What was handed over, on the pane, as the Articles tab reads it back.
  const handedOver = { 'data-help-query': query ?? undefined, 'data-help-article': article ?? undefined };
  if (loading && !choices) return <div className="help-ask-pane" aria-busy="true" data-help-pane="ask" {...handedOver} />;
  if (askableMachines(choices).length === 0) return <AskNeedsMachine choices={choices} articles={articles} handedOver={handedOver} />;

  const offline = choices?.machines.find((m) => !m.online)?.name ?? null;
  const questions = suggestedQuestions({
    errors,
    articles,
    pageArticles: forThisPage(articles, pathname, errors).map((row) => row.article),
    offlineMachine: offline,
  });
  const ask = async (content: string) => {
    if (!chosen || sending) return;
    setSending(true);
    try {
      const made = await createHelpAsk({ content, runnerId: chosen.runnerId, engine: chosen.engine, page });
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'choices'] });
      void qc.invalidateQueries({ queryKey: ['sessions', 'help-ask'] });
      onAsked(made.sessionId);
    } catch (error) {
      toast.error((error as Error).message || 'The question could not be sent.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="help-ask-pane" data-help-pane="ask" {...handedOver}>
      <RunsOn choices={choices} chosen={chosen} onPick={setPick} />
      <div className="help-ask-scroll">
        <div className="help-ask-hero">
          <span className="help-ask-mark" aria-hidden />
          <h3>Ask about Orbit</h3>
          <p>Answers come from the help articles and what Orbit can see on your account. Nothing is changed unless you press a button.</p>
        </div>
        <div className="help-ask-suggestions" role="group" aria-label="Suggested questions">
          {questions.map((q) => (
            <button key={q} type="button" className="help-ask-suggestion" disabled={!chosen || sending} onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
      <AskComposer
        placeholder="Ask a question"
        initial={query ?? ''}
        disabled={!chosen}
        sending={sending}
        chip={page ? { label: page.label, icon: handed ? <FileTextOutlined /> : undefined, onRemove: () => setChipOff(true) } : null}
        onSend={ask}
      />
    </div>
  );
}

/** Board 02 ③A: no machine can answer, so Ask says what is missing and where to start. */
function AskNeedsMachine({
  choices,
  articles,
  handedOver,
}: {
  choices: HelpAskChoices | undefined;
  articles: readonly HelpArticleMeta[];
  handedOver: Record<string, string | undefined>;
}) {
  const navigate = useNavigate();
  const help = useHelpDrawer();
  const startHere = START_HERE.map((slug) => articles.find((a) => a.slug === slug)).filter((a): a is HelpArticleMeta => !!a);
  const shown = startHere.length > 0 ? startHere : getStartedArticles(articles).slice(0, 3);
  // Machines that are online but run a runner too old to answer read-only: updating is the way, not adding one.
  const outdated = (choices?.machines ?? []).some((m) => m.online && !m.supported);
  return (
    <div className="help-ask-pane" data-help-pane="ask" data-help-ask-state="needs-machine" {...handedOver}>
      <div className="help-ask-scroll">
        <div className="help-ask-hero">
          <span className="help-ask-mark is-faint" aria-hidden />
          <h3>Ask needs a machine</h3>
          <p>
            {outdated
              ? 'An agent answers your questions, and agents run on your machines. Update the Orbit runner on one, or add a machine, and Ask works here.'
              : 'An agent answers your questions, and agents run on your machines. Add one and Ask works here. It takes about five minutes.'}
          </p>
          <button
            type="button"
            className="help-ask-primary"
            onClick={() => navigate(ADD_MACHINE_PATH)}
          >
            <PlusOutlined /> Add a machine
          </button>
        </div>
        {shown.length > 0 && (
          <div className="help-ask-start">
            <div className="help-ask-start-heading">Until then, start here</div>
            {shown.map((a, i) => (
              <button key={a.slug} type="button" className="help-ask-start-row" data-row-focus="" onClick={() => help.openHelp({ slug: a.slug })}>
                <span className="help-ask-start-n" aria-hidden>{i + 1}</span>
                <span>{a.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Board 02 ①: "Runs on" — a machine and an engine. Offline machines are shown and cannot be picked. */
function RunsOn({
  choices,
  chosen,
  onPick,
}: {
  choices: HelpAskChoices | undefined;
  chosen: { runnerId: string; engine: string } | null;
  onPick: (pick: { runnerId: string; engine: string }) => void;
}) {
  const machines = choices?.machines ?? [];
  const machine = machines.find((m) => m.id === chosen?.runnerId);
  const footer = <div className="help-ask-menu-note">Orbit remembers this choice for every Ask.</div>;
  const machineItems: MenuItem[] = [{
    type: 'group',
    key: 'machines',
    label: 'Machine',
    children: machines.map((m) => {
      const engine = m.engines.find((e) => e.askable);
      const usable = m.online && m.supported && !!engine;
      return {
        key: m.id,
        label: (
          <span className="help-ask-menu-row">
            <span>{m.name}</span>
            <span className="help-ask-menu-state">{!m.online ? 'Offline' : !m.supported ? 'Update runner' : !engine ? 'No engine' : 'Online'}</span>
          </span>
        ),
        textValue: m.name,
        disabled: !usable,
        selected: m.id === chosen?.runnerId,
        icon: m.id === chosen?.runnerId ? <CheckOutlined /> : undefined,
        onSelect: () => engine && onPick({ runnerId: m.id, engine: engine.engine }),
      };
    }),
  }];
  const engineItems: MenuItem[] = [{
    type: 'group',
    key: 'engines',
    label: `Engine on ${machine?.name ?? 'this machine'}`,
    children: (machine?.engines ?? []).map((e) => ({
      key: e.engine,
      label: (
        <span className="help-ask-menu-row">
          <span>{e.label}</span>
          {!e.askable && <span className="help-ask-menu-state">Not read-only yet</span>}
        </span>
      ),
      textValue: e.label,
      disabled: !e.askable,
      selected: e.engine === chosen?.engine,
      icon: e.engine === chosen?.engine ? <CheckOutlined /> : undefined,
      onSelect: () => machine && onPick({ runnerId: machine.id, engine: e.engine }),
    })),
  }];
  return (
    <div className="help-ask-runs-on">
      <span className="help-ask-runs-on-label">Runs on</span>
      <Menu
        items={machineItems}
        footer={footer}
        trigger={
          <button type="button" className="help-ask-pill" aria-label="Machine">
            {machine?.name ?? 'Pick a machine'} <DownOutlined />
          </button>
        }
      />
      <Menu
        items={engineItems}
        footer={footer}
        disabled={!machine}
        trigger={
          <button type="button" className="help-ask-pill" aria-label="Engine">
            {chosen ? helpAskEngineLabel(chosen.engine) : 'Engine'} <DownOutlined />
          </button>
        }
      />
    </div>
  );
}

/** The composer: the page chip, the question, Read-only, and send. Enter sends; Shift+Enter is a new line. */
function AskComposer({
  placeholder,
  initial = '',
  disabled,
  sending,
  chip,
  onSend,
  inputRef,
}: {
  placeholder: string;
  initial?: string;
  disabled: boolean;
  sending: boolean;
  chip: { label: string; icon?: ReactNode; onRemove: () => void } | null;
  onSend: (text: string) => void | Promise<void>;
  /** The question box, for Still stuck → Tell it what's still wrong to put the cursor in. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const send = () => {
    const words = text.trim();
    if (!words || disabled || sending) return;
    void Promise.resolve(onSend(words)).then(() => setText(''));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  return (
    <div className="help-ask-composer">
      {chip && (
        <span className="help-ask-chip" data-help-ask-chip>
          {chip.icon ?? <span className="help-ask-chip-page" aria-hidden />}
          <span>{chip.label}</span>
          <button type="button" aria-label={`Remove ${chip.label}`} onClick={chip.onRemove}>
            <CloseOutlined />
          </button>
        </span>
      )}
      <textarea
        ref={inputRef}
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="help-ask-composer-foot">
        <span className="help-ask-readonly">Read-only</span>
        <button type="button" className="help-ask-send" aria-label="Send" disabled={!text.trim() || disabled || sending} onClick={send}>
          <ArrowUpOutlined />
        </button>
      </div>
    </div>
  );
}

/**
 * One Ask as a conversation (board 02 ②): the question, the collapsed line of what was looked at, the answer with its
 * [n] chips, the source list, the link buttons, and "Did this answer it?" — whose No opens the slot the Still stuck
 * card fills. A follow-up is a turn of the same session. Drawn in the drawer and on /help → Your questions.
 */
export function AskConversation({
  sessionId,
  choices,
  onBack,
  onOpenArticle,
}: {
  sessionId: string;
  choices: HelpAskChoices | undefined;
  onBack?: () => void;
  onOpenArticle: (slug: string, path: string) => void;
}) {
  const session = useQuery({ ...sessionQuery(sessionId), refetchInterval: (q) => (q.state.data && isSessionLive(q.state.data) ? 4000 : false) });
  const row = session.data as (Record<string, unknown> & { title?: string; costUsd?: number; assignedRunnerId?: string; engine?: string; model?: string | null }) | undefined;
  const live = !!row && isSessionLive(row as never);
  const stream = useSessionStream({
    sessionId,
    live,
    runStatus: row ? sessionRunStatusOf(row as never) : undefined,
    runTerminal: !!row && isSessionTerminal(row as never),
  });
  const exchanges = useMemo(() => askExchanges(stream.events), [stream.events]);
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const machine = choices?.machines.find((m) => m.id === row?.assignedRunnerId)?.name;
  const engine = row?.engine ? helpAskEngineLabel(row.engine) : null;
  const meta = [machine, [engine, row?.model ? claudeModelName(row.model) : null].filter(Boolean).join(' · '), typeof row?.costUsd === 'number' ? `$${row.costUsd.toFixed(2)}` : null]
    .filter(Boolean)
    .join(' · ');
  const working = !stream.idle || isSessionQueued((row ?? {}) as never);
  // Down to the newest words, and once more when the answer ends and "Did this answer it?" appears under it.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [exchanges.length, stream.streamingText, working]);
  const followUp = async (content: string) => {
    setSending(true);
    try {
      await sendTurn(sessionId, content);
    } catch (error) {
      toast.error((error as Error).message || 'The follow-up could not be sent.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="help-ask-pane" data-help-pane="ask" data-help-ask-session={sessionId}>
      <div className="help-ask-head">
        {onBack && (
          <button type="button" className="help-ask-back" aria-label="New question" onClick={onBack}>
            <LeftOutlined />
          </button>
        )}
        <div className="help-ask-head-text">
          <div className="help-ask-title">{row?.title ?? exchanges[0]?.question ?? 'Ask'}</div>
          {meta && <div className="help-ask-meta">{meta}</div>}
        </div>
      </div>
      <div className="help-ask-scroll help-ask-thread">
        {exchanges.map((ex, i) => (
          <Exchange
            key={ex.seq}
            sessionId={sessionId}
            exchange={ex}
            streaming={i === exchanges.length - 1 && working ? stream.streamingText : ''}
            working={i === exchanges.length - 1 && working}
            last={i === exchanges.length - 1}
            onOpenArticle={onOpenArticle}
            stillStuck={
              <StillStuck
                sessionId={sessionId}
                exchanges={exchanges}
                onTellIt={() => composer.current?.focus()}
              />
            }
          />
        ))}
        {exchanges.length === 0 && <div className="help-ask-working">Starting on {machine ?? 'your machine'}…</div>}
        <div ref={bottom} />
      </div>
      <AskComposer placeholder="Ask a follow-up" disabled={working} sending={sending} chip={null} onSend={followUp} inputRef={composer} />
    </div>
  );
}

function Exchange({
  sessionId,
  exchange,
  streaming,
  working,
  last,
  onOpenArticle,
  stillStuck,
}: {
  sessionId: string;
  exchange: AskExchange;
  streaming: string;
  working: boolean;
  last: boolean;
  onOpenArticle: (slug: string, path: string) => void;
  /** The Still stuck card, shown under the last answer once it is answered No. */
  stillStuck: ReactNode;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const { vote: verdict, choose: setVerdict } = useHelpVote('answer', askAnswerId(sessionId, exchange.seq));
  const text = working && streaming ? streaming : exchange.answer;
  const parsed = useMemo(() => parseAnswer(text), [text]);
  const line = toolLine(exchange.tools);
  return (
    <div className="help-ask-exchange">
      <div className="help-ask-question">{exchange.question}</div>
      {exchange.tools.length > 0 && (
        <div className="help-ask-tools">
          <button type="button" className="help-ask-tool-line" aria-expanded={toolsOpen} onClick={() => setToolsOpen((o) => !o)}>
            <CheckOutlined /> {line || `${exchange.tools.length} lookups`} <RightOutlined className={toolsOpen ? 'is-open' : undefined} />
          </button>
          {toolsOpen && (
            <ul className="help-ask-tool-list">
              {exchange.tools.map((t, i) => (
                <li key={i}>
                  <code>{t.name}</code> {t.about}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {text ? (
        <AskAnswer parsed={parsed} onOpenArticle={onOpenArticle} />
      ) : working ? (
        <div className="help-ask-working">Looking…</div>
      ) : exchange.error ? (
        <div className="help-ask-error">{exchange.error}</div>
      ) : null}
      {last && !working && text && (
        <div className="help-ask-verdict">
          <span>Did this answer it?</span>
          <button type="button" aria-pressed={verdict === 'yes'} onClick={() => setVerdict('yes')}>Yes</button>
          <button type="button" aria-pressed={verdict === 'no'} onClick={() => setVerdict('no')}>No</button>
        </div>
      )}
      {last && !working && verdict === 'no' && stillStuck}
    </div>
  );
}

declare const __APP_VERSION__: string;

/** Two letters for the admin's mark: "Alex Li" → "AL". */
const initialsOf = (name: string) =>
  name.trim().split(/\s+/u).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';

/**
 * Still stuck (board 02 ② right frame, side note 5): under an answer the person said No to. Tell it what's still
 * wrong puts the cursor in this Ask's own composer; Ask your admin — to a person who is not an admin — sends the
 * conversation to an admin as a task in their list; Report on GitHub shows exactly what a report carries, then opens
 * a new issue with it on the repository this Orbit was released from.
 */
function StillStuck({
  sessionId,
  exchanges,
  onTellIt,
}: {
  sessionId: string;
  exchanges: readonly AskExchange[];
  onTellIt: () => void;
}) {
  const stuck = useQuery(helpAskStuckQuery(sessionId));
  const qc = useQueryClient();
  const toast = useToast();
  const [sent, setSent] = useState<{ adminName: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const data = stuck.data;
  const withAdmin = sent ?? data?.sentToAdmin ?? null;
  const conversation = exchanges.map((ex) => ({ question: ex.question, answer: ex.answer }));
  const body = data
    ? reportBody({
        orbitVersion: __APP_VERSION__,
        client: 'web',
        machine: data.report.machine,
        exchanges: conversation,
        privateNames: data.report.privateNames,
      })
    : '';
  const sendToAdmin = async () => {
    if (sending || withAdmin) return;
    setSending(true);
    try {
      const made = await askYourAdmin(sessionId, {
        exchanges: conversation.map((ex) => ({ question: ex.question, answer: answerText(ex.answer) })),
      });
      setSent({ adminName: made.adminName });
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'stuck', sessionId] });
      void qc.invalidateQueries({ queryKey: ['sessions', 'help-ask'] });
    } catch (error) {
      toast.error((error as Error).message || 'The question could not be sent to your admin.');
    } finally {
      setSending(false);
    }
  };
  const openIssue = () => {
    if (!data) return;
    const url = reportIssueUrl(data.report.repository, reportTitle(exchanges[0]?.question ?? 'Ask', data.report.privateNames), body);
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  return (
    <div className="help-ask-still-stuck" data-help-still-stuck>
      <div className="help-ask-stuck-card">
        <div className="help-ask-stuck-head">
          <div className="help-ask-stuck-title">Still stuck?</div>
          <div className="help-ask-stuck-sub">Say what's still wrong and the agent tries again, or hand it to a person.</div>
        </div>
        <button type="button" className="help-ask-stuck-row" data-row-focus="" data-help-stuck="retry" onClick={onTellIt}>
          <span className="help-ask-stuck-icon" aria-hidden><EditOutlined /></span>
          <span className="help-ask-stuck-text"><span>Tell it what's still wrong</span></span>
          <RightOutlined className="help-ask-stuck-chevron" />
        </button>
        {data?.admin && (
          <button
            type="button"
            className="help-ask-stuck-row"
            data-row-focus=""
            data-help-stuck="admin"
            disabled={sending || !!withAdmin}
            onClick={() => void sendToAdmin()}
          >
            <span className="help-ask-stuck-icon is-person" aria-hidden>{initialsOf(withAdmin?.adminName ?? data.admin.name)}</span>
            <span className="help-ask-stuck-text">
              <span>Ask your admin</span>
              <span className="help-ask-stuck-note">
                {withAdmin
                  ? `Sent to ${withAdmin.adminName}. It is in their tasks.`
                  : sending
                    ? `Sending to ${data.admin.name}…`
                    : `${data.admin.name} · sends this chat as a task`}
              </span>
            </span>
            {withAdmin ? <CheckOutlined className="help-ask-stuck-chevron" /> : <RightOutlined className="help-ask-stuck-chevron" />}
          </button>
        )}
        <button
          type="button"
          className="help-ask-stuck-row"
          data-row-focus=""
          data-help-stuck="github"
          aria-expanded={reviewing}
          disabled={!data}
          onClick={() => setReviewing((r) => !r)}
        >
          <span className="help-ask-stuck-icon is-github" aria-hidden><GithubOutlined /></span>
          <span className="help-ask-stuck-text">
            <span>Report on GitHub</span>
            <span className="help-ask-stuck-note">Opens a prefilled issue. You review it first.</span>
          </span>
          <ExportOutlined className="help-ask-stuck-chevron" />
        </button>
      </div>
      {reviewing && data && (
        <div className="help-ask-report" data-help-report>
          <div className="help-ask-report-heading">What a report includes</div>
          <pre className="help-ask-report-body" data-help-report-body>{body}</pre>
          <div className="help-ask-report-foot">
            <span>{REPORT_NOT_INCLUDED}.</span>
            <button type="button" className="help-ask-primary" onClick={openIssue}>
              Open on GitHub <ExportOutlined />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Keeps the answer's own schemes for the components below; every other URL goes through the safe transform. */
const keepAskLinks = (url: string) => (url.startsWith('cite:') || url.startsWith('orbit:/') ? url : defaultUrlTransform(url));

function AskAnswer({ parsed, onOpenArticle }: { parsed: ReturnType<typeof parseAnswer>; onOpenArticle: (slug: string, path: string) => void }) {
  const navigate = useNavigate();
  const account = useHelpAccount();
  const bySource = new Map<number, AskSource>(parsed.sources.map((s) => [s.n, s]));
  const components: Components = {
    a: ({ href, children }) => {
      const n = citationOf(href);
      if (n !== null) {
        const source = bySource.get(n);
        return (
          <button
            type="button"
            className="help-ask-cite"
            aria-label={source ? `Source ${n}: ${source.title}` : `Source ${n}`}
            onClick={() => source && onOpenArticle(source.slug, source.path)}
          >
            {n}
          </button>
        );
      }
      if (typeof href === 'string' && /^https?:\/\//u.test(href)) {
        return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
      }
      return <>{children}</>;
    },
  };
  const buttons = parsed.buttons
    .map((b) => ({ ...b, to: resolveOrbitLink(b.href, account.links) }))
    .filter((b): b is typeof b & { to: string } => !!b.to);
  return (
    <div className="help-ask-answer">
      <div className="help-ask-answer-body">
        <Markdown remarkPlugins={[remarkGfm]} urlTransform={keepAskLinks} components={components}>
          {parsed.body}
        </Markdown>
      </div>
      {parsed.sources.length > 0 && (
        <ol className="help-ask-sources" aria-label="Sources">
          {parsed.sources.map((s) => (
            <li key={s.n}>
              <span className="help-ask-cite is-static" aria-hidden>{s.n}</span>
              <button type="button" className="help-ask-source" onClick={() => onOpenArticle(s.slug, s.path)}>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      )}
      {buttons.length > 0 && (
        <div className="help-ask-buttons">
          {buttons.map((b) => (
            <button
              key={b.href}
              type="button"
              className="help-ask-button"
              data-orbit-link={b.href}
              onClick={() => navigate(b.to)}
            >
              {b.label} ›
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
