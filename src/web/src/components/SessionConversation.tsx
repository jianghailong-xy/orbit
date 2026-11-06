import type { ComponentProps, ContextType } from 'react';
import { useNavigate } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import type { SessionStream } from '../lib/useSessionStream';
import { OrbitLinkCardsProvider } from './OrbitLinkCard';
import { AnsweredQuestionsCtx } from './OwnerAnswerLine';
import {
  AuthErrorCtx,
  AutoRetryCtx,
  EventFullCtx,
  LiveToolOutputsCtx,
  SessionNavCtx,
  SteerWithdrawCtx,
  StreamingDraftsCtx,
  TaskActivityCtx,
  Transcript,
  type TranscriptInsert,
  type TurnImage,
  UndeliveredCtx,
} from './Transcript';

/**
 * A session's live conversation: the transcript of what `useSessionStream` holds, inside the
 * contexts its cards read — opening another session, a clipped event's whole payload, the help an
 * auth error or an auto-retry offers, putting an undelivered message back, withdrawing a steer,
 * live shell output and task progress, and the drafts being generated. The shared page and the
 * export draw `Transcript` with none of them.
 */
export function SessionConversation({
  sessionId,
  stream,
  live,
  turnImages,
  inserts,
  authErrorHelp,
  autoRetryHelp,
  restoreUndelivered,
  steerWithdrawal,
  linkStateWord,
  linkRefreshKey,
  answeredQuestions,
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
  restoreUndelivered: ContextType<typeof UndeliveredCtx>;
  steerWithdrawal: ContextType<typeof SteerWithdrawCtx>;
  /** The word a link card says for the session it links to. Pass a module-level function: it
   *  reaches every card, and a new one each render would re-render all of them. */
  linkStateWord: ComponentProps<typeof OrbitLinkCardsProvider>['stateWord'];
  /** Moves when the conversation's own data is re-read. */
  linkRefreshKey: number;
  answeredQuestions: ContextType<typeof AnsweredQuestionsCtx>;
}) {
  const navigate = useNavigate();
  return (
    <SessionNavCtx.Provider value={(rawId) => navigate(`/sessions/${encodeId(rawId)}`)}>
      <EventFullCtx.Provider value={stream.fetchEventFull}>
        <AuthErrorCtx.Provider value={authErrorHelp}>
          <AutoRetryCtx.Provider value={autoRetryHelp}>
            <UndeliveredCtx.Provider value={restoreUndelivered}>
              <SteerWithdrawCtx.Provider value={steerWithdrawal}>
                <LiveToolOutputsCtx.Provider value={stream.liveToolOutputs}>
                  <TaskActivityCtx.Provider value={stream.taskActivity}>
                    <StreamingDraftsCtx.Provider value={stream.streamingDrafts}>
                      {/* The links in this conversation, drawn as cards. The provider is what makes a
                          card possible at all — the shared page and the export mount none — and it
                          re-reads the links when the conversation's detail is re-read, which is the
                          only clock the console has. */}
                      <OrbitLinkCardsProvider stateWord={linkStateWord} refreshKey={linkRefreshKey}>
                        <AnsweredQuestionsCtx.Provider value={answeredQuestions}>
                          <Transcript
                            events={stream.transcriptEvents}
                            live={live}
                            turnImages={turnImages}
                            artifactSessionId={sessionId}
                            streamingAfterSeq={stream.streamingAfterSeq}
                            inserts={inserts}
                          />
                        </AnsweredQuestionsCtx.Provider>
                      </OrbitLinkCardsProvider>
                    </StreamingDraftsCtx.Provider>
                  </TaskActivityCtx.Provider>
                </LiveToolOutputsCtx.Provider>
              </SteerWithdrawCtx.Provider>
            </UndeliveredCtx.Provider>
          </AutoRetryCtx.Provider>
        </AuthErrorCtx.Provider>
      </EventFullCtx.Provider>
    </SessionNavCtx.Provider>
  );
}
