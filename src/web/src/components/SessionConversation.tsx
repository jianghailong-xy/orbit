import { useMemo, type ComponentProps, type ContextType } from 'react';
import type { SubagentRunView } from '@orbit/shared';
import { useNavigate } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { useSubagentRuns } from '../lib/subagentRuns';
import { useWorkflowRuns, WorkflowRunsCtx } from '../lib/workflowRuns';
import type { SessionStream } from '../lib/useSessionStream';
import { OrbitLinkCardsProvider } from './OrbitLinkCard';
import { BgJobHostCtx, JobQueuedWakesCtx } from './JobCard';
import { AnsweredQuestionsCtx } from './OwnerAnswerLine';
import { SubagentQueuedWakesCtx } from './SubagentCardEnd';
import { WikiDraftCardCtx, type WikiDraftCardHost } from './WikiDraftCard';
import {
  AuthErrorCtx,
  AutoRetryCtx,
  EventFullCtx,
  LiveToolOutputsCtx,
  PendingSendCtx,
  SandboxFixCtx,
  SessionNavCtx,
  SteerWithdrawCtx,
  StreamingDraftsCtx,
  SubagentRunsCtx,
  SubagentWaitingCtx,
  TaskActivityCtx,
  Transcript,
  type TranscriptInsert,
  type TurnImage,
  UndeliveredCtx,
} from './Transcript';

const NO_SUBAGENT_WAITING: ReadonlyMap<string, string> = new Map();
const NO_QUEUED_WAKES: ReadonlyMap<string, () => void> = new Map();
const NO_EVENTS: SessionStream['transcriptEvents'] = [];

/**
 * A session's live conversation: the transcript of what `useSessionStream` holds, inside the
 * contexts its cards read — opening another session, a clipped event's whole payload, the help an
 * auth error or an auto-retry offers, putting an undelivered message back, withdrawing a steer,
 * live shell output and task progress, and the drafts being generated. The shared page and the
 * export draw `Transcript` with none of them.
 *
 * A WIKI CHAT'S CARDS (contract `chat.drafts.toolResult`): given `wikiChat`, a drafting call is drawn as the card its
 * answer names — in the panel beside the wiki and on the full session page alike — with the ways the card opens a
 * section, an entry or Review from where it is drawn. Without it the same call is drawn as any tool call.
 */
export function SessionConversation({
  sessionId,
  stream,
  live,
  turnImages,
  inserts,
  authErrorHelp,
  autoRetryHelp,
  sandboxFixHelp = null,
  restoreUndelivered,
  steerWithdrawal,
  pendingSend = null,
  linkStateWord,
  linkRefreshKey,
  answeredQuestions,
  wikiChat = null,
  subagentWaiting = NO_SUBAGENT_WAITING,
  subagentRuns: givenRuns,
  subagentQueuedWakes = NO_QUEUED_WAKES,
  jobQueuedWakes = NO_QUEUED_WAKES,
  jobWhere = null,
}: {
  sessionId: string;
  stream: SessionStream;
  /** Whether the transcript keeps a working clock over the turn in flight. */
  live: boolean;
  turnImages: Record<string, TurnImage[]>;
  /** Drawn among the events (`Transcript`'s `inserts`). Pass a stable array. */
  inserts: readonly TranscriptInsert[];
  authErrorHelp: ContextType<typeof AuthErrorCtx>;
  autoRetryHelp: ContextType<typeof AutoRetryCtx>;
  /** Fix with an agent under a caught sandbox warning (`SandboxFixCtx`); null where there is no machine. */
  sandboxFixHelp?: ContextType<typeof SandboxFixCtx>;
  restoreUndelivered: ContextType<typeof UndeliveredCtx>;
  steerWithdrawal: ContextType<typeof SteerWithdrawCtx>;
  /** Retry or take back a message the server has not taken (`PendingSendCtx`); null where nothing is sent. */
  pendingSend?: ContextType<typeof PendingSendCtx>;
  /** The word a link card says for the session it links to. Pass a module-level function: it
   *  reaches every card, and a new one each render would re-render all of them. */
  linkStateWord: ComponentProps<typeof OrbitLinkCardsProvider>['stateWord'];
  /** Moves when the conversation's own data is re-read. */
  linkRefreshKey: number;
  answeredQuestions: ContextType<typeof AnsweredQuestionsCtx>;
  /** The card host of a wiki chat (`WikiDraftCard`); null for any other session. */
  wikiChat?: WikiDraftCardHost | null;
  /** What each SubAgent waits for a person to approve, by its delegate call (`SubagentWaitingCtx`). */
  subagentWaiting?: ReadonlyMap<string, string>;
  /** The session's SubAgent runs, when the page already reads them (`useSubagentRuns`); else read here. */
  subagentRuns?: ReadonlyMap<string, SubagentRunView>;
  /** Each SubAgent end turn still on the queue, by run id: its `Don't send` (`SubagentQueuedWakesCtx`). */
  subagentQueuedWakes?: ReadonlyMap<string, () => void>;
  /** Each background job's wake still on the queue, by job id: its `Don't send` (`JobQueuedWakesCtx`). */
  jobQueuedWakes?: ReadonlyMap<string, () => void>;
  /** Where the session runs, as a bg_run job's opened card names it (`BgJobHost.where`). */
  jobWhere?: string | null;
}) {
  const navigate = useNavigate();
  const ownRuns = useSubagentRuns(sessionId, givenRuns ? NO_EVENTS : stream.transcriptEvents);
  const subagentRuns = givenRuns ?? ownRuns;
  const workflowRuns = useWorkflowRuns(sessionId, stream.transcriptEvents);
  // Where a bg_run job's card reads its tail and asks to stop it, and the list that says whether it can be.
  const jobHost = useMemo(
    () => ({ sessionId, serverShells: stream.serverBgShells, where: jobWhere }),
    [sessionId, stream.serverBgShells, jobWhere],
  );
  return (
    <SessionNavCtx.Provider value={(rawId) => navigate(`/sessions/${encodeId(rawId)}`)}>
      <EventFullCtx.Provider value={stream.fetchEventFull}>
        <AuthErrorCtx.Provider value={authErrorHelp}>
          <AutoRetryCtx.Provider value={autoRetryHelp}>
            <UndeliveredCtx.Provider value={restoreUndelivered}>
              <SteerWithdrawCtx.Provider value={steerWithdrawal}>
              <PendingSendCtx.Provider value={pendingSend}>
                <LiveToolOutputsCtx.Provider value={stream.liveToolOutputs}>
                  <TaskActivityCtx.Provider value={stream.taskActivity}>
                    <SubagentRunsCtx.Provider value={subagentRuns}>
                    <WorkflowRunsCtx.Provider value={workflowRuns}>
                    <SubagentWaitingCtx.Provider value={subagentWaiting}>
                    <SubagentQueuedWakesCtx.Provider value={subagentQueuedWakes}>
                    <BgJobHostCtx.Provider value={jobHost}>
                    <JobQueuedWakesCtx.Provider value={jobQueuedWakes}>
                    <StreamingDraftsCtx.Provider value={stream.streamingDrafts}>
                      {/* The links in this conversation, drawn as cards. The provider is what makes a
                          card possible at all — the shared page and the export mount none — and it
                          re-reads the links when the conversation's detail is re-read, which is the
                          only clock the console has. */}
                      <OrbitLinkCardsProvider stateWord={linkStateWord} refreshKey={linkRefreshKey}>
                        <AnsweredQuestionsCtx.Provider value={answeredQuestions}>
                          <WikiDraftCardCtx.Provider value={wikiChat}>
                            <SandboxFixCtx.Provider value={sandboxFixHelp}>
                              <Transcript
                                events={stream.transcriptEvents}
                                live={live}
                                turnImages={turnImages}
                                artifactSessionId={sessionId}
                                streamingAfterSeq={stream.streamingAfterSeq}
                                inserts={inserts}
                              />
                            </SandboxFixCtx.Provider>
                          </WikiDraftCardCtx.Provider>
                        </AnsweredQuestionsCtx.Provider>
                      </OrbitLinkCardsProvider>
                    </StreamingDraftsCtx.Provider>
                    </JobQueuedWakesCtx.Provider>
                    </BgJobHostCtx.Provider>
                    </SubagentQueuedWakesCtx.Provider>
                    </SubagentWaitingCtx.Provider>
                    </WorkflowRunsCtx.Provider>
                    </SubagentRunsCtx.Provider>
                  </TaskActivityCtx.Provider>
                </LiveToolOutputsCtx.Provider>
              </PendingSendCtx.Provider>
              </SteerWithdrawCtx.Provider>
            </UndeliveredCtx.Provider>
          </AutoRetryCtx.Provider>
        </AuthErrorCtx.Provider>
      </EventFullCtx.Provider>
    </SessionNavCtx.Provider>
  );
}
