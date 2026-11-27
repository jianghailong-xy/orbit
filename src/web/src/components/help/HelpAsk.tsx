import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpOutlined, CheckOutlined, CloseOutlined, EditOutlined, ExportOutlined, FileTextOutlined, GithubOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { HelpAskPage } from '@orbit/shared';
import Markdown from '../Markdown';
import { useHelpDrawer } from '../../lib/helpDrawer';
import { forThisPage, routeLabel } from '../../lib/help/drawerArticles';
import { askAnswerId, useHelpVote } from '../../lib/help/helpFeedback';
import { useHelpLanguage } from '../../lib/help/helpLanguage';
import { helpArticlePath, helpIndexQuery } from '../../lib/help/helpQueries';
import { resolveOrbitLink } from '../../lib/help/helpContent';
import {
  askExchanges,
  askPage,
  citationOf,
  createHelpAsk,
  followUpHelpAsk,
  helpAskQuery,
  parseAnswer,
  suggestedQuestions,
  type AskExchange,
  type AskSource,
} from '../../lib/help/helpAsk';
import { useHelpAccount } from '../../lib/help/useHelpAccount';
import {
  askYourAdmin,
  helpAskStuckQuery,
  REPORT_NOT_INCLUDED,
  reportBody,
  reportIssueUrl,
  reportTitle,
} from '../../lib/help/stillStuck';
import { useVisibleHelpErrors } from '../../lib/help/useVisibleHelpErrors';
import { runnersQuery } from '../../lib/queries';
import { runnerIsOffline, type AttentionRunner } from '../../lib/runnerAttention';
import { useToast } from '../../lib/toast';
import './HelpAsk.css';

/**
 * The help drawer's Ask tab (docs/mocks/help-center board 02 ①–②): a new question — suggested questions from the page
 * and its errors, the page attached as a chip, Read-only — or the conversation the drawer is on. The server answers on
 * its own DeepSeek key; the person only asks. `query` is a question handed over from the Articles tab's search,
 * `article` the article its Ask instead was pressed on.
 */
export function HelpAskPane({ query, article }: { query: string | null; article: string | null }) {
  const help = useHelpDrawer();
  if (help.askSession) {
    return (
      <AskConversation
        askId={help.askSession}
        onBack={() => help.setAskSession(null)}
        onOpenArticle={(slug) => help.openHelp({ slug })}
      />
    );
  }
  return <NewAsk query={query} article={article} onAsked={help.setAskSession} />;
}

/** A new question: the suggestions and the composer. */
function NewAsk({
  query,
  article,
  onAsked,
}: {
  query: string | null;
  article: string | null;
  onAsked: (askId: string) => void;
}) {
  const { pathname } = useLocation();
  const errors = useVisibleHelpErrors();
  const { language } = useHelpLanguage();
  const index = useQuery(helpIndexQuery(language));
  const runners = useQuery(runnersQuery());
  const articles = index.data?.articles ?? [];
  const handed = article ? articles.find((a) => a.slug === article) : undefined;
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
  const now = Date.now();
  const offlineRunner = ((runners.data ?? []) as Array<AttentionRunner & { name: string; displayName?: string | null }>)
    .find((r) => runnerIsOffline(r, now));
  const offline = offlineRunner ? offlineRunner.displayName?.trim() || offlineRunner.name : null;
  const questions = suggestedQuestions({
    errors,
    articles,
    pageArticles: forThisPage(articles, pathname, errors).map((row) => row.article),
    offlineMachine: offline,
  });
  const ask = async (content: string) => {
    if (sending) return;
    setSending(true);
    try {
      const made = await createHelpAsk({ content, page });
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'list'] });
      onAsked(made.id);
    } catch (error) {
      toast.error((error as Error).message || 'The question could not be sent.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="help-ask-pane" data-help-pane="ask" {...handedOver}>
      <div className="help-ask-scroll">
        <div className="help-ask-hero">
          <span className="help-ask-mark" aria-hidden />
          <h3>Ask about Orbit</h3>
          <p>Answers come from the help articles and what Orbit can see on your account. Nothing is changed unless you press a button.</p>
        </div>
        <div className="help-ask-suggestions" role="group" aria-label="Suggested questions">
          {questions.map((q) => (
            <button key={q} type="button" className="help-ask-suggestion" disabled={sending} onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
      <AskComposer
        placeholder="Ask a question"
        initial={query ?? ''}
        disabled={false}
        sending={sending}
        chip={page ? { label: page.label, icon: handed ? <FileTextOutlined /> : undefined, onRemove: () => setChipOff(true) } : null}
        onSend={ask}
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
 * One Ask as a conversation (board 02 ②): each question, the answer with its [n] chips, the source list, the link
 * buttons, and "Did this answer it?" — whose No opens the slot the Still stuck card fills. A follow-up is the next
 * question of the same Ask. Drawn in the drawer and on /help → Your questions.
 */
export function AskConversation({
  askId,
  onBack,
  onOpenArticle,
}: {
  askId: string;
  onBack?: () => void;
  onOpenArticle: (slug: string, path: string) => void;
}) {
  const conversation = useQuery(helpAskQuery(askId));
  const qc = useQueryClient();
  const data = conversation.data;
  const exchanges = useMemo(() => askExchanges(data?.messages ?? []), [data?.messages]);
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const working = data?.status === 'working';
  // Down to the newest words, and once more when the answer ends and "Did this answer it?" appears under it.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [exchanges.length, working]);
  const followUp = async (content: string) => {
    setSending(true);
    try {
      const next = await followUpHelpAsk(askId, content);
      qc.setQueryData(helpAskQuery(askId).queryKey, next);
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'list'] });
    } catch (error) {
      toast.error((error as Error).message || 'The follow-up could not be sent.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="help-ask-pane" data-help-pane="ask" data-help-ask-session={askId}>
      <div className="help-ask-head">
        {onBack && (
          <button type="button" className="help-ask-back" aria-label="New question" onClick={onBack}>
            <LeftOutlined />
          </button>
        )}
        <div className="help-ask-head-text">
          <div className="help-ask-title">{data?.title ?? exchanges[0]?.question ?? 'Ask'}</div>
        </div>
      </div>
      <div className="help-ask-scroll help-ask-thread">
        {exchanges.map((ex, i) => (
          <Exchange
            key={ex.index}
            askId={askId}
            exchange={ex}
            working={i === exchanges.length - 1 && working}
            last={i === exchanges.length - 1}
            onOpenArticle={onOpenArticle}
            stillStuck={
              <StillStuck
                askId={askId}
                exchanges={exchanges}
                onTellIt={() => composer.current?.focus()}
              />
            }
          />
        ))}
        {conversation.isError && <div className="help-ask-error">{(conversation.error as Error).message || 'This question could not be read.'}</div>}
        <div ref={bottom} />
      </div>
      <AskComposer placeholder="Ask a follow-up" disabled={working || !data} sending={sending} chip={null} onSend={followUp} inputRef={composer} />
    </div>
  );
}

function Exchange({
  askId,
  exchange,
  working,
  last,
  onOpenArticle,
  stillStuck,
}: {
  askId: string;
  exchange: AskExchange;
  working: boolean;
  last: boolean;
  onOpenArticle: (slug: string, path: string) => void;
  /** The Still stuck card, shown under the last answer once it is answered No. */
  stillStuck: ReactNode;
}) {
  const { vote: verdict, choose: setVerdict } = useHelpVote('answer', askAnswerId(askId, exchange.index));
  const text = exchange.answer;
  const parsed = useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="help-ask-exchange">
      <div className="help-ask-question">{exchange.question}</div>
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
 * wrong puts the cursor in this Ask's own composer; Ask your admin — to a person who is not an admin — has the server
 * send the conversation to an admin as a task in their list; Report on GitHub shows exactly what a report carries, then opens
 * a new issue with it on the repository this Orbit was released from.
 */
function StillStuck({
  askId,
  exchanges,
  onTellIt,
}: {
  askId: string;
  exchanges: readonly AskExchange[];
  onTellIt: () => void;
}) {
  const stuck = useQuery(helpAskStuckQuery(askId));
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
        exchanges: conversation,
        privateNames: data.report.privateNames,
      })
    : '';
  const sendToAdmin = async () => {
    if (sending || withAdmin) return;
    setSending(true);
    try {
      const made = await askYourAdmin(askId);
      setSent({ adminName: made.adminName });
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'stuck', askId] });
      void qc.invalidateQueries({ queryKey: ['help', 'ask', 'list'] });
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
