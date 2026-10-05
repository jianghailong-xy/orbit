import { type MergeRecoveryAction, type ProjectSidebarTaskCounts } from '@orbit/shared';
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownloadOutlined,
  DownOutlined,
  EditOutlined,
  EllipsisOutlined,
  EyeOutlined,
  ExportOutlined,
  FolderOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  LinkOutlined,
  LoadingOutlined,
  MessageOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyReferencePick,
  materializeReferences,
  referenceToken,
  type ReferenceMap,
} from '../lib/composerRefs';
import { settleThinking } from '../lib/thinkingDraft';
import {
  NEAR_BOTTOM,
  READER_INPUT_GRACE_MS,
  TAIL_SAMPLE_ZERO,
  pinnedToTail,
  sampleTail,
  type TailScrollSample,
} from '../lib/tailPinning';
import {
  elementForSeq,
  JUMP_TO_LATEST,
  LOADING_NEWER,
  RECORD_FLASH_MS,
  RECORD_NOT_FOUND,
  RECORD_PARAM,
  recordAtOf,
  recordScrollDelta,
} from '../lib/transcriptDeepLink';
import { memoizeEventFull } from '../lib/eventFull';
import { plainPreview } from '../lib/plainPreview';
import { navigateWithPaneSlide, showsConversation } from '../lib/paneTransition';
import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Popover, Select, Spin, Tooltip } from 'antd';
import {
  type DragEvent as ReactDragEvent,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { copyText } from '../lib/clipboard';
import { REPO_CLEANUP_QUEUED, repoCleanupConfirm } from '../lib/repoCleanup';
import { routeId, encodeId } from '../lib/idCodec';
import { useIsMobile, useMediaQuery } from '../lib/useMediaQuery';
import {
  dragOffset,
  isFullSwipe,
  restingOffset,
  sessionSwipeActions,
  settleSwipe,
  swipeActionsOnScreen,
  swipeGeometry,
  swipeWidths,
  SWIPE_ACTION_WIDTH,
  type SwipeAction,
  type SwipeGeometry,
  type SwipeSide,
} from '../lib/sessionSwipe';
import { useControlPlaneLive } from '../lib/useControlPlane';
import { useSessionProjectData } from '../lib/useSessionProjectData';
import {
  workspacesQuery,
  type Me,
  meQuery,
  providersQuery,
  SESSION_PAGE_SIZE,
  sessionQuery,
  sessionFoldersQuery,
  type SessionListView,
  sessionsQuery,
  sessionTagsQuery,
  ownerConfirmationQuery,
  openProjectsQuery,
  projectDetailsQuery,
  projectSessionsQuery,
  PROJECT_SESSION_REFRESH_MS,
  pendingCriteriaDecisionsQuery,
  pendingDecisionsQuery,
  projectMergedPromotionsQuery,
  projectOpenItemsQuery,
  projectPromotionQuery,
  sessionCreatedTasksQuery,
  watchesQuery,
} from '../lib/queries';
import { SEARCH_HINT, openSessionSearch } from './SessionSearch';
import { SessionMoveModal, type MoveDialogSession } from './SessionMoveModal';
import {
  FOLDER_COPY,
  MOVE_COPY,
  folderDeleteFailure,
  folderNameDraft,
  folderNameFailure,
  listShowsFolders,
  type SessionFolderRow,
} from '../lib/sessionFolders';
import {
  SESSION_PROJECT_COPY,
  listShowsProjects,
  sessionProjectListing,
  type SessionProjectRow,
  type SessionProjectEntry,
} from '../lib/sessionProjects';
import { SidebarNavIcon } from './SidebarNavIcon';
import {
  type SessionTagRef,
  sessionTagSections,
  sessionTimeSections,
  sessionsWithTag,
} from '../lib/sessionGrouping';
import {
  type ConfiguredProvider,
  clampPermissionModeForModel,
  permissionModeSupported,
  contextWindowFor,
  DEFAULT_MODEL,
  defaultModelForProvider,
  effectiveSessionEffort,
  effectiveSessionModel,
  effortOptionsForProvider,
  livePinnedModel,
  modelOptionsForProvider,
  newSessionEffortForProvider,
  newSessionModelForProvider,
  normalizeEffortForProvider,
  providerIdentityResolved,
  runtimeForProvider,
  supportsAuto,
} from '../lib/workspaceDefaults';
import {
  LOCAL_SLASH_ITEMS,
  isLocalSlashCommand,
  localStatusRows,
  openSlash,
  pickSlash as replaceSlashToken,
  slashAssetMatchesProvider,
  slashCommandName,
  slashMatches as getSlashMatches,
  slashToken as getSlashToken,
  supportsRunnerSlashAssets,
  type ComposerSlashItem,
  type LocalStatusRow,
} from '../lib/slashCommands';
import { sessionPlanUsage } from '../lib/planUsage';
import { accountNameOf, accountPlanUsage } from '../lib/engineAccounts';
import { poolAccountHelp, poolsAsProviders, providerPoolsQuery, sessionPoolAccount } from '../lib/providerPools';
import { isLoginPool, poolSessionLoginMember } from '../lib/codexLogin';
import { sharedPoolAsProviderPool, sharedPoolsQuery } from '../lib/sharedPools';
import {
  decideContextSeed,
  dirtyContextSeed,
  type ContextSeedState,
} from '../lib/contextSeed';
import { SessionOutputs } from './SessionOutputs';
import { NewSessionProviderHero } from './NewSessionProviderHero';
import {
  currentProviderChoice,
  providerChoices,
  sameRuntimeChoices,
} from '../lib/sessionProviderChoices';
import { BackgroundShellsTray } from './BackgroundShellsTray';
import { SessionCreatedTasksStrip } from './SessionCreatedTasksStrip';
import { SessionWatchBadges, SessionWatchStrip } from './WatchRelations';
import { WatchWakeCard } from './WatchWakeCard';
import { BackgroundWakeCard } from './BackgroundWakeCard';
import { OpenItemDeliveryCard } from './OpenItemDeliveryCard';
import { OrbitLinkCardsProvider } from './OrbitLinkCard';
import { ProjectStartedCard } from './ProjectStartedCard';
import { SessionMessageCard } from './SessionMessageCard';
import {
  parseWatchWake,
  sessionWatching,
  watchingCountWord,
  watchingSessions,
  watchingWord,
  type SessionWatching,
} from '../lib/watches';
import { parseBackgroundWake } from '../lib/backgroundWake';
import { returnsToComposer } from '../lib/queuedTurnRestore';
import type { BgShell } from '../lib/backgroundShells';
import { deriveBackgroundShells, mergeBackgroundShells } from '../lib/backgroundShells';
import {
  EMPTY_LIVE_TASK_PROGRESS,
  reduceLiveTaskProgress,
  type SessionLiveTaskProgress,
} from '../lib/liveTaskProgress';
import {
  api,
  ApiError,
  type ActiveSessionTurn,
  type ApprovalInfo,
  armAutoRetry,
  completeSession,
  cancelAutoRetry,
  cancelQueuedTurn,
  adoptSessionBranch,
  commitSession,
  createMergeRepairSession,
  createInteractiveSession,
  createSessionFolder,
  decideApproval,
  deleteSession,
  deleteSessionFolder,
  cleanUpWorkspaceRepo,
  enableWorkspaceIsolation,
  getBackgroundShells,
  getSession,
  interruptSession,
  listApprovals,
  listQueuedTurns,
  mergeSessionToMain,
  type EventPageEvent,
  type PermissionRule,
  pinSession,
  purgeSession,
  getSessionEventFull,
  getSessionEventPage,
  getSessionEventPageAfter,
  getSessionEventPageAround,
  getSessionRetryMessage,
  resendSessionRetryMessage,
  type TranscriptAroundPage,
  renameSession,
  renameSessionFolder,
  restoreSession,
  resumeSession,
  type SessionFolder,
  type SessionListItem,
  sendTurn,
  sessionEventsUrl,
  unpinSession,
  updateSessionConfig,
  switchSessionAccount,
  uploadAttachment,
} from '../api';
import { DshRepairCard } from './Transcript';
import { DSH_RUNNER_CAPABILITY, dshRepair } from '../lib/dshRuntime';
import { AntigravityRepairCard, antigravityRepair, AttachmentImage, AuthErrorCtx, type AuthErrorHelp, AutoRetryCtx, type AutoRetryHelp, ChatImage, EventFullCtx, LiveToolOutputsCtx, MD, SessionNavCtx, StreamingDraftsCtx, TaskActivityCtx, type TaskActivity, Transcript, type TurnImage, UndeliveredCtx } from './Transcript';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { ApprovalPanel, DECLINE_PLACEHOLDER, decliningPrefix } from './ApprovalPanel';
import {
  SessionDecisionStrip,
  decisionRowKey,
  revealCriteriaCard,
  revealCard,
  REVIEW_CARD_REVEALED,
  revealOpenItemCard,
  revealSettlementCard,
  type PendingDecisionRow,
} from './DecisionRail';
import {
  CriteriaDecisionReceipt,
  SessionCriteriaDecisionCard,
  type CriteriaDecisionReply,
} from './CriteriaDecisionCard';
import { CoordinatorQuestions } from './CoordinatorQuestionCard';
import {
  ItemAsCard,
  exceptionCardRows,
  isOwnerExceptionCard,
  openItemChatBanner,
  openItemChatContext,
} from './ProjectProgressStatus';
import {
  ProjectPromotion,
  ProjectPromotionCard,
  ProjectPromotionReceipt,
  promotionChatBanner,
  promotionChatContext,
  promotionRecordMoment,
} from './ProjectPromotionCard';
import {
  CHAT_FACTS_AS_ARMED,
  CHAT_SUBJECT_GONE,
  COORDINATOR_CHAT_PLACEHOLDER,
  chatAboutOf,
  chatIntentOf,
  chatSubjectIn,
  coordinatorChatPath,
  itemChat,
  type ChatAbout,
  type CoordinatorChatSubject,
} from '../lib/coordinatorChat';
import { criteriaDecisionReceiptRows, decisionReceiptAnchor } from '../lib/decisionReceipt';
import { acceptanceConfirmationQuery } from '../lib/acceptanceConfirmation';
import {
  DECISION_SEND_BACK_LABEL,
  DECISION_SENDING_BACK_PREFIX,
  EvidenceDecisionReceipt,
  SessionEvidenceDecisionCard,
  evidenceDecisionCardRows,
  evidenceDecisionRefusal,
  sendEvidenceDecision,
} from './EvidenceDecisionCard';
import {
  ACCEPTANCE_PLAN_CHANGE_PREFIX,
  AcceptanceConfirmationReceipt,
  SessionAcceptanceConfirmationCard,
  acceptancePlanChangeContext,
  acceptancePlanChangePlaceholder,
  type SettlementPlanChat,
} from './AcceptanceConfirmationCard';
import {
  READY_TO_START,
  START_PROJECT_INTENT,
  confirmedChangesProjectKey,
  type SettlementQuestion,
} from '../lib/projectStart';
import { PROJECT_DONE_COPY } from '../lib/projectDone';
import { SessionProjectSettlementCard } from './ProjectSettlementCard';
import {
  OWNER_SEND_BACK_LABEL,
  OWNER_SENDING_BACK_PREFIX,
  type OwnerConfirmationWaiting,
  OwnerDecisionReceipt,
  ReviewerReturnRecord,
  SessionOwnerConfirmationCard,
  WAITING_FOR_CONFIRMATION,
  ownerConfirmationWaitingIn,
  ownerDecisionReceiptsIn,
  ownerDecisionRefusal,
  refreshOwnerConfirmationViews,
  reviewerReturnsIn,
  sendOwnerDecision,
} from './OwnerConfirmationCard';
import { OwnerConfirmationReopen } from './OwnerConfirmationReopen';
import { UNDER_REVIEW, underReviewLine } from './OwnerConfirmationReview';
import { ReviewRequestedCard, SentBackByReviewerCard } from './ConfirmationReviewTurnCards';
import { ComposerMirror } from './ComposerMirror';
import { FIND_HINT, openSessionFind, SessionFind } from './SessionFind';
import { ShareModal } from './ShareModal';
import type { Runner } from './TasksSidePanel';
import { accountsOf } from './AccountSelect';
import { PlanUsageIndicator } from './PlanUsageIndicator';
import type {
  ConfirmationReturnCard,
  ConfirmationReviewRequestCard,
  OpenItemDeliveryCard as OpenItemDelivery,
  ProjectStartedCard as ProjectStarted,
  SessionMessageCard as SessionMessage,
  SessionTurnIntent,
  SessionTurnPlacement,
  WatchView,
} from '@orbit/shared';
import {
  accountOfEnv,
  accountToStartOn,
  AgentProvider,
  derivePermissionSemantics,
  fastModeAvailable,
  MAX_PROMPT_CHARS,
  permissionModeAvailableOnRunner,
  TRASH_RETENTION_DAYS,
  type AccountEngine,
} from '@orbit/shared';
import { lastTypedUserMessage } from '../lib/deliveredMessage';
import { bindingPlanUsageRow, currentPlanUsageRows } from '../lib/planUsage';
import { useToast } from '../lib/toast';
import { setSessionTags } from '../lib/sessionTags';
import { tagChipLabels } from '../lib/tagColor';
import {
  isSessionBusy,
  isSessionLive,
  isSessionTerminal,
  sessionEndedBanner,
  sessionIsStarting,
  sessionLifecycleLabel,
  sessionLifecycleStateOf,
  sessionRetryPending,
  sessionRunStateOf,
  sessionRunStatusOf,
} from '../lib/sessionState';
import { deliveryFailureExplanation, steerDeliveryState, supersedesLiveDrafts } from '../lib/steerDelivery';
import { streamAnchorAfter } from '../lib/streamAnchor';
import { backgroundWorkIsActive, isSessionTurnActive, outlivingSessionWork } from '../lib/sessionActivity';
import type { OutlivingWork } from '../lib/sessionActivity';
import { shouldPollSessionDetail } from '../lib/sessionDetailPolling';
import { firstPaintSlice, transcriptPlaceholder } from '../lib/transcriptPaint';
import { loadTranscript, saveTranscript } from '../lib/transcriptStore';
import {
  clearLiveToolOutputsForSession,
  EMPTY_LIVE_TOOL_OUTPUTS,
  reduceLiveToolOutputs,
  type SessionLiveToolOutputs,
} from '../lib/liveToolOutputs';
import { useDelayedFlag } from '../lib/useDelayedFlag';
import {
  acceptedUserTurnEvent,
  acceptedUserTurnLanded,
  clearAcceptedUserTurnsForSession,
  clearAcceptedUserTurnsForTurn,
  queuedTurnsOutsideTranscript,
  reconcileAcceptedUserTurnSnapshot,
  reconcileQueuedTurnSnapshot,
  transcriptEventsWithDurableDeliveryReceipts,
  type AcceptedUserTurn,
} from '../lib/acceptedUserTurn';
import { turnPlacementOf } from '../lib/turnPlacement';
import { commitFailureCopy, resolveCommitPrompt } from '../lib/commitFailure';
import { defaultSessionTurnIntent } from '../lib/sessionTurnIntent';
import {
  composerDraftAfterSend,
  isCurrentWorkUnavailable,
  logicalSendToken,
  resolveConflictLogicalSendToken,
  type LogicalSendToken,
} from '../lib/composerSendState';
import {
  TASK_RUN_RESEND_AFTER_MS,
  TASK_RUN_RESEND_MAX_ATTEMPTS,
  providerSwitchNote as providerSwitchNoteFor,
  readTaskRunConflict,
  routedToSession,
  stillHeldAfterWaiting,
  stopSessionIdFor,
  type TaskRunConflict,
  type TaskRunConflictAction,
} from '../lib/taskRunHandoff';
import { TaskRunHandedOverNotice, TaskRunHandoffNotice } from './TaskRunHandoffNotice';
import {
  isCompleteShortcutEligible,
  scopedAttachmentCreateBlockedMessage,
  sessionCapabilityOf,
  sessionResumeBlockedMessage,
  sessionResumeBlockedReasonOf,
  sessionSendBlockedMessage,
  sessionSendDispositionOf,
} from '../lib/sessionCapabilities';
import {
  QUEUED_NOTICE_DELAY_MS,
  STARTING_NOTICE_DELAY_MS,
  type QueuedGate,
  pendingSlotDescription,
  queuedLabel,
  queuedNoticeVisible,
  queuedTitle,
  runnerSlotUsage,
  startingDescription,
  startingLabel,
  startingTitle,
  waitElapsedLabel,
  waitingNoticeFor,
  waitingNoticeScope,
} from '../lib/runnerSlots';
import { reseedWithActiveSnapshot } from '../lib/reseedActiveSnapshot';

interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  turnId?: string | null;
  ts?: string;
}

// A user message accepted while a turn is running: it sits in the inbox (PENDING)
// until the current turn finishes. Tracked locally so the composer can show it and
// offer to withdraw it before the runner picks it up. A `!cmd` shell turn queues the
// same way, so it gets a bubble too — rendered as the command it will run.
export interface QueuedTurn {
  turnId: string;
  content: string;
  shell?: boolean;
  /** Server receipt only: current-turn/next-turn is never inferred from local status. */
  placement: Extract<SessionTurnPlacement, 'steer' | 'queued'>;
  /** For a steer, the executable turn it was written into. */
  targetTurnId?: string;
  delivery?: 'failed' | 'unconfirmed';
  deliveryCode?: string;
  deliveryReason?: string;
  // Server-side image refs (id + mime), so a reopened/reloaded queue can still render an
  // image-only follow-up turn — the local turnImages previews don't survive a reload.
  attachments?: { id: string; mimeType: string }[];
  /** When the server queued it — the receipt's own timestamp, as an accepted turn's `acceptedAt`. */
  createdAt?: string;
  /** An exception item's delivery carries the item's own fields beside its words, exactly as the
   *  accepted-turn placeholder does (`AcceptedUserTurn.openItemDelivery`): the queued tail draws the
   *  card the transcript will, rather than a bubble it replaces when the runner takes the turn. */
  openItemDelivery?: OpenItemDelivery;
  /** The same for the message telling a coordinator its project was started (`ProjectStartedCard`). */
  projectStarted?: ProjectStarted;
  /** And for a confirmation review's two turns: the request a reviewer is handed, and the reviewer's
   *  return handed to the run (`ActiveSessionTurn.confirmationReviewRequest` / `confirmationReturn`). */
  confirmationReviewRequest?: ConfirmationReviewRequestCard;
  confirmationReturn?: ConfirmationReturnCard;
  /** Another Orbit session's message, and who sent it (`ActiveSessionTurn.sessionMessage`): drawn as
   *  the "From [that session]" card its echo will be, and never handed back to the reader's composer. */
  sessionMessage?: SessionMessage;
  /** The control plane wrote this turn itself, so nobody typed it (`ActiveSessionTurn.authoredByOrbit`). */
  authoredByOrbit?: true;
}

/** Map one authoritative active-snapshot receipt into the pending-tail renderer. `accepted` is
 * represented by the optimistic/transcript bridge instead, so it deliberately has no queue row. */
export function queuedTurnFromActiveSnapshot(row: ActiveSessionTurn): QueuedTurn | null {
  const placement = turnPlacementOf(row);
  if (placement === 'accepted') return null;
  return {
    ...row,
    shell: row.kind === 'shell',
    placement,
  };
}

interface LocalStatusCard {
  id: string;
  rows: LocalStatusRow[];
}

interface SessionToastTarget {
  id: string;
  title: string;
  projectId?: string;
}

type PendingSessionOperation =
  | (SessionToastTarget & { token: number; kind: 'merge'; target?: string })
  | (SessionToastTarget & { token: number; kind: 'commit' });

// An attachment staged in the composer: uploaded to the control plane (POST /api/attachments)
// the moment it's picked/pasted, then sent by id with the turn. `previewUrl` is a local
// object URL for the thumbnail — set only for inline images; a non-image file renders as a
// chip (name + size) instead. `id` is set once the upload resolves.
//
// `file` is the local blob, and only something picked here has one. An attachment handed back out
// of a message that was already sent — withdrawn, or taken back undelivered — has no blob and needs
// none: its bytes are on the server under `id`, which is the whole of what a send references. So
// what the chip shows is carried beside the blob rather than read out of it, and `size` is absent
// for the ones the server describes (the queue snapshot reports id and mime, not length).
interface ComposerImage {
  uid: string;
  file?: File;
  name: string;
  mime: string;
  size?: number;
  previewUrl?: string;
  status: 'uploading' | 'done';
  id?: string;
}

/** One press of Send, named so a refusal can be kept beside the message it refused and re-sent
 *  unchanged once the reader has answered it. */
interface ComposerSendVars {
  content: string;
  images: ComposerImage[];
  /** Attachments the control plane already holds, referenced by id — what a re-send carries
   *  of the message it re-sends. Nothing is uploaded again; the bytes never moved. */
  attachmentIds?: string[];
  shell?: boolean;
  intent?: SessionTurnIntent;
  /** Set only by answering a `CONFIRM_SWITCH` — the one thing that authorises stopping the
   *  run that holds this task. Carried on the SEND rather than held in state so the
   *  authorisation travels with the message it was given for. */
  stopSessionId?: string;
  /** Which control pressed Send. Only the auto-retry card's own Retry names itself, and only so
   *  that a refusal about who holds the task is answered where the press was — on the card, whose
   *  offer to re-send is what stopped being true — instead of twice, in two places at once. */
  source?: 'autoRetry';
}

// The image types Claude takes as inline content blocks: shown as a thumbnail and capped
// tighter (kept in sync with the runner's image-block dispatch). Anything else is a generic
// file — any type, up to the server's 25MB cap (attachments.media.ts).
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Compact byte size for a staged file chip ("12 KB", "3.4 MB").
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// UI label <-> claude --permission-mode value — the full set claude 2.1.x accepts.
// Prompting modes (Default/Plan/Accept Edits) work without a TTY because the runner
// routes permission prompts to the orbit approval panel (the MCP permission_prompt
// tool). "Don't Ask" auto-denies anything not pre-allowed; "Bypass" skips all checks.
const MODE_TO_PERMISSION: Record<string, string> = {
  Default: 'default',
  Plan: 'plan',
  'Accept Edits': 'acceptEdits',
  Auto: 'auto',
  "Don't Ask": 'dontAsk',
  Bypass: 'bypassPermissions',
};
const PERMISSION_TO_MODE: Record<string, string> = Object.fromEntries(
  Object.entries(MODE_TO_PERMISSION).map(([label, value]) => [value, label]),
);
const MODE_OPTIONS = Object.keys(MODE_TO_PERMISSION);

// New-session hotkey hint. The chord itself accepts ⌘/Ctrl on every platform; only the
// label differs — ⌘ on macOS, Ctrl elsewhere (matches ApprovalPanel's convention). The
// hint is only *shown* in standalone/PWA mode, because a normal browser tab reserves ⌘N
// for "New Window" and the page can't override it — advertising it there would mislead.
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const NEW_SESSION_HINT = IS_MAC ? '⌘N' : 'Ctrl N';
const COMPLETE_SESSION_HINT = IS_MAC ? '⌘D' : 'Ctrl D';
/** A runner that carries a session's conversation onto another of its accounts (runner
 *  codex_account_move.go, claude_account_move.go) — the one kind the composer offers the move on. */
const ACCOUNT_MOVE_CAPABILITY: Record<AccountEngine, string> = {
  codex: 'codex-account-move/v1',
  claude: 'claude-account-move/v1',
};
/** What the composer sends to put a session back on Automatic (PATCH /sessions/:id/account). */
const AUTOMATIC_ACCOUNT = 'automatic';

// 94_000 → "94k", 1_000_000 → "1M". Compact token count for the context gauge.
const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`;

// The latest usable context-window occupancy (tokens). New runners report it on
// `turn_end`; a lightweight status event can also refresh the gauge without ending the
// active turn. Older runners omit the field; keep scanning so a later missing value
// does not blank a known reading. Derived from `events` — which holds the boot tail
// page (so it's right on cold open) plus live appends — rather than a separate live signal.
// The window that reading is a fraction of, taken from the same event rather than looked up: the
// runner reports both halves together (see the runner's model_window.go), because a denominator
// resolved separately can describe a different model than the numerator it lands under — a
// mid-session model switch, or a table that never knew this CLI's answer. Older runners send no
// window; the caller then falls back to contextWindowFor.
function lastContextReading(events: RunEvent[]): { tokens: number; window?: number } {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i].payload as { contextTokens?: unknown; contextWindow?: unknown } | undefined;
    const ct = payload?.contextTokens;
    if (typeof ct !== 'number' || ct <= 0) continue;
    const cw = payload?.contextWindow;
    return { tokens: ct, window: typeof cw === 'number' && cw > 0 ? cw : undefined };
  }
  return { tokens: 0 };
}

// Donut gauge for the context pill — a distinct silhouette from the linear plan-usage bar so the
// session-local context metric doesn't read as "another usage bar". Brand blue until it
// fills, then ramps amber (≥75%) → red (≥90%) as the window fills.
function ContextRing({ pct, tier }: { pct: number; tier: 'neutral' | 'warn' | 'danger' }) {
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  const frac = Math.min(100, Math.max(0, pct)) / 100;
  return (
    <svg
      className={`context-ring context-ring-${tier}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <circle className="context-ring-track" cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" />
      <circle
        className="context-ring-fill"
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - frac)}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

// Context-window gauge for the composer footer: the ring above + percent of the model's context
// window filled by the latest turn; hover/click reveals the token counts. Distinct from plan
// usage — that's the subscription rate limit.
function ContextWindowIndicator({
  tokens,
  reportedWindow,
  model,
  provider,
  modelCatalog,
  configured,
}: {
  tokens: number;
  /** The window this session reported alongside its tokens, when it did. */
  reportedWindow?: number;
  model: string;
  provider?: string;
  modelCatalog?: Runner['modelCatalog'];
  configured?: ConfiguredProvider[];
}) {
  const windowTokens = reportedWindow ?? contextWindowFor(model, modelCatalog, configured, provider);
  // Two things can be missing, and they are not the same thing. Occupancy is missing until the
  // engine reports it — a fresh session, or a first turn still running; "0%" would claim the
  // window is empty when it is in fact filling. The window can be missing too, and then there is
  // no percentage to show at all: the tokens are still a fact worth displaying, but dividing them
  // by a guess is how this gauge spent a release reading 83% when it should have read 17%.
  const known = tokens > 0;
  const sized = (windowTokens ?? 0) > 0;
  const pct = known && sized ? Math.min(100, Math.round((tokens / windowTokens!) * 100)) : 0;
  const headline = !known ? '—' : sized ? `${pct}%` : fmtTokens(tokens);
  const pop = (
    <div className="cu-pop">
      <div className="cu-row">
        <div className="cu-head">
          <span className="cu-label">Context window</span>
          <span className="cu-pct">{headline}</span>
        </div>
        {sized && (
          <div className={`runner-util ${pct >= 90 ? 'full' : ''}`}>
            <span className="runner-util-fill" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="cu-reset">
          {!known
            ? sized
              ? `Not reported yet · ${fmtTokens(windowTokens!)} window`
              : 'Not reported yet'
            : sized
              ? `${fmtTokens(tokens)} / ${fmtTokens(windowTokens!)} tokens`
              : `${fmtTokens(tokens)} tokens · window not reported`}
        </div>
      </div>
    </div>
  );
  const tier = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'neutral';
  return (
    <Popover content={pop} title="Context" placement="topRight" trigger={['hover', 'click']}>
      <span
        className="composer-pill composer-usage"
        aria-label={
          !known
            ? 'Context window not reported yet'
            : sized
              ? `Context window ${pct}%`
              : `Context ${fmtTokens(tokens)} tokens, window not reported`
        }
      >
        <ContextRing pct={pct} tier={tier} />
        <span className="composer-usage-pct">{headline}</span>
      </span>
    </Popover>
  );
}

// The slices of the session list, in menu order. Open is the overwhelmingly common
// one, so the other two live in the header's scope menu rather than a permanent tab row.
type SessionView = SessionListView;
const SESSION_VIEWS: { value: SessionView; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'completed', label: 'Completed' },
  { value: 'trash', label: 'Trash' },
];

// How close to the end of the loaded session list the scroll has to get before the next
// page is asked for — roughly a couple of rows, so the list is already widened by the time
// the user reaches the bottom.
const SESSION_LOAD_MORE_PX = 240;

// Drag-resizable width of the left session column, persisted across reloads.
const SESSION_COL_KEY = 'orbit.sessionColWidth';
const SESSION_COL_MIN = 200;
const SESSION_COL_MAX = 560;
const SESSION_COL_DEFAULT = 320;

// Whether the session list's Pinned section is folded to its heading, persisted across reloads.
const PINNED_COLLAPSED_KEY = 'orbit.sessionPinnedCollapsed';

// Delay the SSE (re)connect on a session switch so holding the arrow keys to scrub
// the list doesn't open-then-immediately-close a connection per session skipped past.
const SWITCH_DEBOUNCE_MS = 150;
// Cap on cached transcripts (mount-scoped), so a long browsing session can't grow
// the cache without bound. Least-recently-selected entries are evicted first.
const TRANSCRIPT_CACHE_MAX = 20;
// Tail-first lazy loading: open a fresh transcript with only its newest page (so a long
// session lands straight at the latest message instead of replaying its whole history), then
// prepend older pages as the user scrolls up. TAIL_PAGE is deliberately large enough to fill
// any viewport in one shot, so no auto-load fires until the user actually scrolls up.
const TAIL_PAGE = 200;
const OLDER_PAGE = 200;
// A link to one record (`?at=`, lib/transcriptDeepLink) opens on the page around it instead: half
// before the record and half after, the same size as a tail page so it fills the view as well.
const AROUND_PAGE = 200;
// Consecutive reconnects that fail to move the resume cursor before the transcript stops trying to
// resume and re-seeds from a tail page instead. Three is past any single dropped connection while
// still costing ~12s of the backoff below — short enough that a wedged tab recovers on its own,
// long enough that an ordinary redeploy blip never throws away a loaded window. See reseed().
const RESEED_AFTER_STALLED_RECONNECTS = 3;
// Distance from the top (px) at which scrolling up pulls in the next older page — and, in a window
// opened at a record, from the bottom at which scrolling down pulls in the next newer one.
const LOAD_OLDER_AT = 400;
// A ceiling on the pages "Jump to the beginning" may pull in at once — the same one ⌘F's jump
// runs under (SessionFind's MAX_LOAD_PAGES), for the same reason: 30 pages is well past the
// deepest session in this deployment, so it bounds a runaway without being a working limit. A
// session deeper than that keeps the control, and a second press carries on from where it left.
const JUMP_TO_START_PAGES = 30;
// How long a pinned transcript's tail has to sit out of view, with no content update in between,
// before the jump-to-bottom button offers it anyway (`stranded`; the clients' ConsoleView waits the
// same). The follow a content update triggers lands just after the rows grew, and the gap read in
// between — the normal state while a reply streams — must not flash the button.
const STRANDED_AFTER_MS = 400;
// What the sticky bar calls a turn the person typed. A watch's wake carries its own label on its card
// instead (`data-sticky-label`), since saying this above a card reading "not typed by you" is the
// screen contradicting itself — which is what the account owner photographed on 2026-09-17.
const STICKY_LABEL = 'Your question';
// How long a cached /background scan stays fresh. `/background` scans the session's whole
// tool-event history, so re-opening a session (or scrubbing the list) within this window paints
// the cached shells instead of re-running that scan — see bgCacheRef.
const BG_TTL_MS = 30_000;

interface TranscriptCacheEntry {
  events: RunEvent[];
  oldestSeq: number | null; // seq of the earliest loaded event (null = nothing loaded)
  hasMoreOlder: boolean; // older events exist before oldestSeq on the server
}

// Shell-style composer history, kept per-session in localStorage so the Up/Down arrows
// recall only this session's recently sent prompts (never another session's). Stored
// oldest-first, newest last; capped so it can't grow without bound. Keyed by session id;
// a not-yet-created session (new-session draft) has no id and so no history to recall.
const HISTORY_KEY_PREFIX = 'orbit.composerHistory:';
const HISTORY_MAX = 100;
const historyKey = (sessionId: string): string => `${HISTORY_KEY_PREFIX}${sessionId}`;
function loadHistory(sessionId?: string | null): string[] {
  if (!sessionId) return [];
  try {
    const arr = JSON.parse(localStorage.getItem(historyKey(sessionId)) ?? '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function pushHistory(sessionId: string | undefined, entry: string): void {
  if (!sessionId) return;
  const e = entry.trim();
  if (!e) return;
  const list = loadHistory(sessionId);
  if (list[list.length - 1] === e) return; // skip if identical to the last sent
  list.push(e);
  while (list.length > HISTORY_MAX) list.shift();
  try {
    localStorage.setItem(historyKey(sessionId), JSON.stringify(list));
  } catch {
    // ignore quota/serialization errors — history is best-effort
  }
}

// Recent sessions read better as relative time ("3h ago"); anything older than a
// day falls back to an absolute month/day stamp. hour12:false keeps it compact.
const fmtTime = (d?: string): string => {
  if (!d) return '';
  const t = new Date(d).getTime();
  const diff = Date.now() - t;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff >= 0 && diff < min) return 'just now';
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}h ago`;
  return new Date(t).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

// Shorten a tool id for the live status line: mcp__orbit__task_create -> task_create;
// plain tool names (Bash, Read, Edit) pass through unchanged.
const fmtTool = (name: string): string => name.replace(/^mcp__[^_]+__/, '');

// The runner's own sentence about a finished commit — which background jobs were live in the
// checkout while it committed, and what it did about them (commitResultMessage). Trimmed because a
// whitespace-only value would otherwise draw an empty detail row; null and blank both mean "the
// runner said nothing", which is not a line to draw.
const runnerCommitLine = (value?: string | null): string | undefined => value?.trim() || undefined;

// "Background process running" / "N background processes running" — shown when a session is
// parked at AWAITING_INPUT but still has live background shells (server-tracked
// runningBgCount, from Session.runningBgShells), so it doesn't read as idle.
const bgRunningLabel = (n: number): string =>
  n > 1 ? `${n} background processes running` : 'Background process running';

// "Running Agent" / "Running N agents" — shown while a session is working and has a sub-agent
// (Task/Agent tool) in flight (server-tracked runningSubagentCount, from Session.runningSubagents).
// These are the RUNTIME's own sub-agents, unrelated to a Workspace.
// The async Agent tool_result lands at once, so lastToolUse can't carry this on its own.
const subagentRunningLabel = (n: number): string =>
  n > 1 ? `Running ${n} agents` : 'Running Agent';

// Whether to draw this session as working. RUNNING is the dispatched case. The second one is a
// turn the runtime started for itself — a background task reporting in, a scheduled wake-up —
// which never reaches /turn-complete and so stays parked at AWAITING_INPUT for its whole
// duration, streaming tools and replies the whole time. Server-tracked
// (Session.engineTurnActive), since only the event stream can see it; absent when talking to an
// older control plane, which simply keeps the old parked reading. Both cases get the same glyph,
// header word and list line — without this the row says "Waiting for your reply" over a session
// the user can watch working. Outranks parkedWorkLabel below: this is the workspace itself
// generating, not something it left running behind a finished turn.
const isGenerating = (s: any, state: string): boolean =>
  state === 'RUNNING' || (state === 'AWAITING_INPUT' && s.engineTurnActive === true);

// Live background work that outlives a parked (AWAITING_INPUT) turn — an async sub-workspace
// (Task/Workspace) and/or background shells. Returns the label to surface (sub-workspace wins) with
// the kind behind it, or null when the session is genuinely idle. Shared by the list line,
// status glyph and header so all three agree a parked-but-still-working session isn't
// "waiting for your reply" — and agree on how emphatically to say so: a sub-workspace is the
// workspace still working, while a background shell is usually a dev server or watcher the workspace
// deliberately left up, which keeps reporting for the rest of the session's life.
//
// `active` splits that last case in two without changing a word of it: the same glyph and the same
// "N background processes running" line, but breathing while at least one of those processes is a
// JOB with an end (backgroundWorkIsActive). A job is work the agent started and is waiting on; a
// `service` is the thing that made this static. Nothing else about the row moves.
type ParkedWork = { text: string; kind: OutlivingWork; active: boolean };
const parkedWorkLabel = (s: any): ParkedWork | null => {
  const kind = outlivingSessionWork(s);
  if (!kind) return null;
  return kind === 'subagent'
    ? { text: subagentRunningLabel(s.runningSubagentCount), kind, active: true }
    : { text: bgRunningLabel(s.runningBgCount), kind, active: backgroundWorkIsActive(s) };
};

// The line shown under a session title. For a LIVE (openable) session that's working we
// surface its current state — the tool in flight, that it's blocked on you, or a bare
// "Running…" — so the row never collapses to just a title with no sign of progress.
// Otherwise it's the flattened last reply, falling back to the run's own state word.
// `tone` drives the colour: blue = working, amber = needs you, grey = queued, a left-up
// background process or a watch that will resume it, default = reply content.
type SessionLine = {
  text: string;
  tone: 'preview' | 'running' | 'approval' | 'queued' | 'background' | 'watching' | 'review';
};
// The line for a message of YOURS the workspace hasn't answered yet. Prefixed, because the preview
// line is otherwise the workspace's voice: unmarked, a message you sent and a reply to it read
// exactly alike, and "has it answered me yet?" is the one question the list has to answer while a
// turn is running. Same flattening as a reply preview — it may be markdown too.
const sentLine = (text: string): SessionLine => ({
  text: `You: ${plainPreview(text)}`,
  tone: 'preview',
});

// The four owner items, one word each: no project and no count, because a row is one line and the
// project it is about is the conversation the row already names (contract §7.6 V13). The native
// banner and card say these same words, and `OwnerItemCardsTests` holds the two ends to each other.
const OWNER_ITEM_APPROVE_MERGE = 'Approve merge to main';
const OWNER_ITEM_COORDINATOR_QUESTION = 'Question from coordinator';
const OWNER_ITEM_ESCALATED = 'Escalated to you';
const OWNER_ITEM_PAUSED = 'Paused';

/** The kinds this row can name, and the words it says for each. A kind missing here — one this
 *  build does not know — falls back to the approval wording rather than naming nothing. */
const OWNER_ITEM_WORDS: Record<string, string> = {
  PROMOTION_APPROVAL: OWNER_ITEM_APPROVE_MERGE,
  COORDINATOR_QUESTION: OWNER_ITEM_COORDINATOR_QUESTION,
  ESCALATED: OWNER_ITEM_ESCALATED,
  FUSE_PAUSED: OWNER_ITEM_PAUSED,
};

/**
 * The item a row names: the oldest one it can name, which is the same item the needs-you bar above
 * the list points at. Mirrors `NeedsYouLogic.oldestItemWord` — an unparseable instant sorts last
 * rather than first, so it cannot beat an item whose wait is known.
 */
const ownerItemWord = (s: any): string | null => {
  let oldest: { word: string; at: number } | null = null;
  for (const item of s.ownerItems ?? []) {
    const word = OWNER_ITEM_WORDS[item?.kind];
    if (!word) continue;
    const at = Date.parse(item?.since ?? '');
    const key = Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at;
    if (oldest === null || key < oldest.at) oldest = { word, at: key };
  }
  return oldest?.word ?? null;
};

// What a row that is waiting on you says. The server names the kind when everything it counted is
// one kind with words of its own (`waitingKind`), and the row says it: an OWNER_CONFIRMED task's run
// in the confirmation card's words, one of the four owner items in the words the bar and the card
// share — a row reading "Waiting for approval" over an escalated exception describes the one thing
// that is certainly not happening — and a project waiting to be started, "Ready to start". Anything
// else waiting on you keeps the approval wording.
// Only the words change — the row still carries no button: the one place to answer is the card in
// the session.
const waitingLabel = (s: any): string => {
  if (s.waitingKind === 'OWNER_CONFIRMATION') return WAITING_FOR_CONFIRMATION;
  if (s.waitingKind === 'OWNER_ITEM') return ownerItemWord(s) ?? 'Waiting for approval';
  // A project its coordinator asked to start: the row says what the card in it asks, not an
  // approval nobody is being asked for.
  if (s.waitingKind === 'START_REQUEST') return READY_TO_START;
  if (s.waitingKind === 'DONE_REQUEST') return PROJECT_DONE_COPY.readyToClose;
  if (s.waitingKind === 'RECORD_AS_DONE') return PROJECT_DONE_COPY.recordAsDoneRow;
  return 'Waiting for approval';
};

// `watching` is this session as an observer — what its row says about the live watches that will
// resume it (lib/watches `watchingSessions`) — and absent wherever a caller holds no watches.
export const sessionLine = (s: any, live: boolean, watching?: SessionWatching | null): SessionLine => {
  const state = sessionRunStateOf(s);
  // Somebody is waiting on YOU here, which outranks everything else the row could say: every other
  // line reports what the workspace is doing, and this one is the only one you can act on.
  //
  // Deliberately OUTSIDE the generating gate it used to live inside. A blocked tool call keeps the
  // turn open, so "generating" was a free ride for it; the owner decisions the server now counts
  // here (see `owner-decision-signal.ts`) are held open by nobody, so they outlive the turn that
  // delivered their card and sit on a PARKED conversation. Inside the gate, a real criteria
  // decision waiting for an answer left this row reading as an idle reply preview.
  if (live && (s.pendingApprovals ?? 0) > 0)
    return { text: waitingLabel(s), tone: 'approval' };
  // The same place for a run whose report is still with its reviewer (contract §5 N3): its card is
  // drawn and can be pressed, but nobody is asking the owner yet, so the row says who has it in the
  // secondary tone — never the amber of a row waiting on you, and never counted.
  if (live && s.confirmationUnderReview)
    return { text: underReviewLine(s.confirmationUnderReview.reviewerTitle), tone: 'review' };
  // Outranks the generating preview below. While the engine is starting, or compacting, it has
  // produced nothing since the wait began, so that preview would echo the message back as though it
  // were being answered (see waitingNoticeFor). Blue, because this is progress — just not the
  // agent's yet.
  if (live && waitingNoticeFor(s)) return { text: `${startingLabel(s)}…`, tone: 'running' };
  if (live && isGenerating(s, state)) {
    if (s.lastToolUse) return { text: `Running ${fmtTool(s.lastToolUse)}…`, tone: 'running' };
    // A sub-workspace in flight: lastToolUse is already cleared (the async Workspace tool_result +
    // the parent's own system progress events), so surface it explicitly instead of falling
    // through to the muted last-reply preview, which reads as idle.
    if ((s.runningSubagentCount ?? 0) > 0)
      return { text: `${subagentRunningLabel(s.runningSubagentCount)}…`, tone: 'running' };
    // The workspace hasn't answered yet: show the message you sent (the server keeps lastUserText
    // from the moment it is enqueued until a reply lands) instead of the previous turn's reply,
    // which would read as if this one had already been answered. It's content, not status — the
    // spinner already carries "working" — so it takes the muted preview tone, not blue.
    if (s.lastUserText) return sentLine(s.lastUserText);
    if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
    return { text: 'Running…', tone: 'running' };
  }
  if (live && state === 'QUEUED') return { text: queuedLabel(s), tone: 'queued' };
  // Parked (AWAITING_INPUT) but still doing background work — a sub-workspace and/or background
  // shells that outlive the turn — so it doesn't read as idle. A spawned sub-workspace parks the
  // parent at AWAITING_INPUT while it runs, so this (not the RUNNING branch) is what usually
  // surfaces "Running Agent…".
  const parked = live ? parkedWorkLabel(s) : null;
  if (parked?.kind === 'subagent') return { text: `${parked.text}…`, tone: 'running' };
  // Parked on a live watch that will resume it: not idle, not waiting on you, and — whatever else it
  // left running — not a background process (contract §9.2). Said in the strip's own line, so the row
  // and the strip above its composer read the same.
  if (live && watching && state === 'AWAITING_INPUT') return { text: watching.line, tone: 'watching' };
  if (parked) return { text: `${parked.text}…`, tone: 'background' };
  // A message that never got an answer — the turn was interrupted, or failed, before any reply
  // landed — outranks the previous turn's reply: it's the newer of the two, and it's what the
  // session is left waiting on. The server only keeps lastUserText while it stands unanswered.
  if (s.lastUserText) return sentLine(s.lastUserText);
  if (s.lastAssistantText) return { text: plainPreview(s.lastAssistantText), tone: 'preview' };
  // Nothing to preview at all (a run that died before even its user turn was recorded, or an older
  // row from before the server kept the pending message): say what happened rather than nothing.
  return { text: statusLabel(s), tone: 'preview' };
};

/**
 * Where the header's "back" goes for a session that coordinates a project, and what it is called.
 *
 * A coordinator conversation is opened from a project's page and executes no task, so the task
 * link beside it never applies and the way back used to be the browser's own button. Reads the
 * session's `projectId`/`projectTitle`: the link only exists in that direction — the project owns
 * the pointer — so both list and detail payloads project that relation onto the session row.
 */
export function projectBackLink(session: any): { path: string; title: string | null } | null {
  if (!session?.projectId) return null;
  return { path: `/projects/${encodeId(session.projectId)}`, title: session.projectTitle ?? null };
}

/** Relation metadata, deliberately separate from user-created tags. Optional `projectId` keeps
 * rolling upgrades quiet: an older API simply renders no badge. */
export function CoordinatorBadge({ projectId }: { projectId?: string | null }) {
  if (!projectId) return null;
  return (
    <span className="coordinator-badge" title="This session coordinates a project">
      Coordinator
    </span>
  );
}

/** What the globe beside a row's time says: a public link opens this session right now. */
export const SESSION_SHARED_TIP = 'Shared · anyone with the link';

/** The title is the only flexible item: time, merge state, and coordinator relation stay visible
 * while a long title ellipsizes into whatever width remains. */
export function SessionTitleRow({
  session: s,
  hoverTipOpen = false,
}: { session: any; hoverTipOpen?: boolean }) {
  return (
    <div className="session-title-row">
      <div className="session-title">{s.title}</div>
      {(s.mergeStatus === 'error' || s.mergeStatus === 'conflict') && (
        <Tooltip
          title={s.mergeStatus === 'conflict' ? 'Merge conflict — needs resolving' : 'Merge failed'}
          placement="top"
          open={hoverTipOpen}
        >
          <span className="session-merge-badge">⚠</span>
        </Tooltip>
      )}
      {/* The list row's `shared` (docs/share-links-design.md §8). A native title rather than a
          Tooltip: nothing to linger on a touch screen, where a tap opens the row. */}
      {s.shared === true && (
        <span className="session-shared" title={SESSION_SHARED_TIP} aria-label={SESSION_SHARED_TIP}>
          <GlobalOutlined />
        </span>
      )}
      <span className="session-time">{fmtTime(s.lastTurnAt ?? s.createdAt)}</span>
      <CoordinatorBadge projectId={s.projectId} />
    </div>
  );
}

function SessionProjectProgressBar({ counts, runningCount }: { counts: ProjectSidebarTaskCounts; runningCount: number }) {
  const total = counts.total;
  const done = Math.min(counts.done, total);
  const failed = Math.min(counts.failed, total - done);
  const running = Math.min(runningCount, total - done - failed);
  const width = (count: number) => `${total > 0 ? count / total * 100 : 0}%`;
  return (
    <span className="session-project-progress-bar" aria-hidden="true">
      <span className="done" style={{ width: width(done) }} />
      <span className="running" style={{ width: width(running) }} />
      <span className="failed" style={{ width: width(failed) }} />
    </span>
  );
}

/** A project occupies the coordinator's row, using the same two lines as a session. A click opens
 *  the project's sessions page; the menu's Open Session reaches the grouping target. */
export function SessionProjectListRow({
  project,
  active,
  onOpen,
  menu,
  menuOpen,
  onMenuOpenChange,
  swipe,
}: {
  project: SessionProjectRow<any>;
  active: boolean;
  onOpen: () => void;
  menu: MenuProps;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  swipe?: {
    offset: number;
    dragging: boolean;
    onStart: (e: ReactTouchEvent) => void;
    onMove: (e: ReactTouchEvent) => void;
    onEnd: () => void;
    onCancel: () => void;
    onAction: (action: 'pin' | 'move') => void;
  };
}) {
  const counts = project.taskCounts;
  return (
    <div
      className={`session-row session-project-row${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`}
      data-project-id={project.projectId}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onMenuOpenChange(true); }}
      onTouchStart={swipe?.onStart}
      onTouchMove={swipe?.onMove}
      onTouchEnd={swipe?.onEnd}
      onTouchCancel={swipe?.onCancel}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onOpen();
      }}
    >
      {swipe && (['leading', 'trailing'] as const).map((side) => {
        const action = side === 'leading' ? 'pin' : 'move';
        const label = action === 'pin' && project.coordinator?.pinnedAt ? 'Unpin' : action === 'pin' ? 'Pin' : 'Move';
        return (
          <div key={side} className={`session-swipe-actions ${side}${swipe.dragging ? ' dragging' : ''}`}
            style={{ width: Math.max(0, side === 'leading' ? swipe.offset : -swipe.offset) }}>
            <button type="button" className={`session-swipe-action ${action}`} aria-label={label} tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); swipe.onAction(action); }}>
              <span className="session-swipe-glyph">
                {action === 'move' ? <FolderOutlined /> : project.coordinator?.pinnedAt ? <PushpinFilled /> : <PushpinOutlined />}
              </span>
              <span className="session-swipe-title" aria-hidden="true">{label}</span>
            </button>
          </div>
        );
      })}
      <div className={`session-swipe${swipe?.dragging ? ' dragging' : ''}`}
        style={swipe?.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}>
        <span className="session-icon session-project-icon">
          {project.indicator === 'running' ? <RunningStatusIcon /> : (
            <>
              <SidebarNavIcon name="projects" />
              {project.indicator && (
                <span
                  className={`session-project-status ${project.indicator}`}
                  data-state={project.indicator}
                  aria-label={project.indicator === 'needs-you' ? 'Waiting for you' : 'Background jobs'}
                />
              )}
            </>
          )}
        </span>
        <div className="session-main">
          <div className="session-title-row">
            <div className="session-title">{project.title}</div>
            <span className="session-time">{fmtTime(project.lastTurnAt ?? project.createdAt ?? undefined)}</span>
          </div>
          <div className="session-sub">
            <span
              className={`session-project-progress${project.status === 'DONE' ? ' done' : ''}`}
              title={SESSION_PROJECT_COPY.progressHint(project.sessionCount, project.runningCount)}
            >
              {counts ? (
                <>
                  <SessionProjectProgressBar counts={counts} runningCount={project.runningCount} />
                  {SESSION_PROJECT_COPY.progress(counts.done, counts.total)}
                </>
              ) : project.status}
            </span>
            <div
              className={`session-preview${project.line.tone === 'preview' ? '' : ` tone-${project.line.tone}`}`}
              title={project.line.text}
            >
              {project.line.text}
            </div>
          </div>
        </div>
      </div>
      <div className="session-right">
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
          <Dropdown trigger={['click']} placement="bottomRight" menu={menu} open={menuOpen} onOpenChange={onMenuOpenChange}>
            <button type="button" className="session-kebab" aria-label="Project actions" aria-haspopup="menu" aria-expanded={menuOpen}>
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
      </div>
    </div>
  );
}

/** Compact tag summary for a session-list row. The first tag is the one users can scan; the
 * fixed count survives when that name has to ellipsize, and a container query swaps to the total
 * count when the resizable session column becomes too narrow to show a useful name. */
export function SessionTagChips({
  tags,
  tooltipOpen,
}: {
  tags?: SessionTagRef[] | null;
  tooltipOpen?: boolean;
}) {
  if (!tags?.length) return null;

  const first = tags[0];
  const label = tagChipLabels(first.color);
  const names = tags.map((tag) => tag.name).join(', ');

  return (
    <>
      <Tooltip title={names} placement="top" open={tooltipOpen}>
        <span className="session-tag-chips" aria-hidden="true">
          <span className="session-tag-named">
            <span
              className="session-tag-chip"
              style={
                {
                  '--chip': first.color,
                  '--chip-label': label.light,
                  '--chip-label-dark': label.dark,
                } as React.CSSProperties
              }
            >
              <span className="session-tag-chip-label">{first.name}</span>
            </span>
          </span>
          {tags.length > 1 && (
            <span className="session-tag-more session-tag-more--remaining">+{tags.length - 1}</span>
          )}
          <span className="session-tag-more session-tag-more--total">+{tags.length}</span>
        </span>
      </Tooltip>
      {/* Generic spans cannot reliably take an accessible name from aria-label. Keep the real
          names as text outside the visual summary so compact layouts may hide the named chip. */}
      <span className="sr-only">Tags: {names}</span>
    </>
  );
}

// State word for the session header — mirrors StatusIcon's branching (and its tooltip
// wording) so the glyph and the header label always agree.
//
// `watching` is this session as an observer: the word for the live watches that will resume it
// (lib/watches `watchingWord`), which the header reads instead of "Waiting for your reply" — a wake
// is coming, and nobody is being asked for one. Absent wherever a caller has no watches to hand
// (the search palette's rows), which keeps the previous reading rather than inventing one.
export function statusLabel(session: any, watching?: string | null): string {
  const state = sessionRunStateOf(session);
  // Same ordering as `sessionLine`, and outside the generating gate for the same reason: an owner
  // decision is not held open by a turn, so it is still waiting once the conversation parks.
  if ((session.pendingApprovals ?? 0) > 0) return waitingLabel(session);
  // Where `Waiting for your confirmation` would be, while the report is with its reviewer (§5 N3).
  if (session.confirmationUnderReview) return UNDER_REVIEW;
  if (state === 'SUCCEEDED') return 'Succeeded';
  if (waitingNoticeFor(session)) return startingLabel(session);
  if (isGenerating(session, state)) return 'Running';
  if (state === 'AWAITING_INPUT') {
    // A sub-workspace is this workspace still working, so it outranks the wait it is parked on; a
    // background shell it left up is not, and a watch is not a process either (contract §9.2), so
    // the wait is said in the watch's own words before the tray's.
    const parked = parkedWorkLabel(session);
    if (parked?.kind === 'subagent') return parked.text;
    return watching ?? parked?.text ?? 'Waiting for your reply';
  }
  if (state === 'FAILED') {
    if (sessionRetryPending(session)) return 'Retrying';
    const err: string = typeof session.error === 'string' ? session.error : '';
    return err.toLowerCase().includes('offline') ? 'Disconnected' : 'Failed';
  }
  if (state === 'INTERRUPTED') return 'Interrupted';
  if (state === 'ENDED') return 'Ended';
  return queuedLabel(session); // PENDING
}

// What a failed session's glyph says — StatusIcon's FAILED tooltips, word for word: the error
// itself where the header says only "Failed".
function failedTitle(session: any): string {
  if (sessionRetryPending(session)) return 'Retrying — the run resumes on its own';
  const err: string = typeof session.error === 'string' ? session.error : '';
  if (err.toLowerCase().includes('offline')) return 'Disconnected — runner went offline';
  return err || 'Failed';
}

/**
 * The word an Orbit link card says for the session it links to: the header's own, with the watching
 * word a session list row would give it — except a failure, which says what its glyph says (the
 * error itself), as the native card does. A preview carries the counts rather than the watch rows, so
 * `watchingCountWord` says what the strip says from what the card was handed.
 *
 * Module-level and not a closure: it is handed to every card of the conversation through the cards
 * context, and a fresh function on every render would re-render every one of them.
 */
export function orbitLinkStateWord(row: any): string {
  // A decision waiting on the owner still outranks the failure, in the order `statusLabel` keeps.
  if (sessionRunStateOf(row) === 'FAILED' && !((row?.pendingApprovals ?? 0) > 0)) return failedTitle(row);
  return statusLabel(row, watchingCountWord(row?.watching));
}

/**
 * StatusIcon reduced to its motion, branch for branch in its order: the spinner of a session at
 * work, the breathing terminal of a background job in flight, or neither. A folder row reports
 * these for the sessions filed in it (lib/sessionFolders), so a folder and its rows can't disagree.
 */
export function statusGlyphMotion(session: any, watching?: string | null): 'spinner' | 'pulse' | null {
  const state = sessionRunStateOf(session);
  if ((session.pendingApprovals ?? 0) > 0 || state === 'SUCCEEDED') return null;
  if (waitingNoticeFor(session) || isGenerating(session, state)) return 'spinner';
  if (state !== 'AWAITING_INPUT') return null;
  const work = parkedWorkLabel(session);
  if (!work || (watching && work.kind !== 'subagent')) return null;
  return work.kind === 'subagent' ? 'spinner' : work.active ? 'pulse' : null;
}

/** Whether a session counts toward a folder row's needs-you number: it waits on you, and not only to
 *  have its project started, which lights no tally anywhere (the rail's and the drawer's rule). */
export const sessionNeedsYou = (session: any): boolean =>
  (session.pendingApprovals ?? 0) > 0 && session.waitingKind !== 'START_REQUEST';

function RunningStatusIcon() {
  return (
    <Tooltip title="Running">
      <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize: 16 }} />
    </Tooltip>
  );
}

// One glyph per session state. Colour carries the meaning: blue = working,
// amber = needs a human decision, green = the run reported success, red = real failure,
// grey = neutral terminal (ended / interrupted / disconnected). A runner that
// went offline is reaped to FAILED with error 'runner offline'; that's a dropped
// connection, not a crash, so it gets the neutral disconnect glyph, not a red X.
// New payloads carry the authoritative runState. The resolver retains a centralized fallback
// for old servers whose raw status collapses graceful ends to CANCELLED.
//
// `watching` is the word for the live watches that will resume this session (`statusLabel`'s), and
// absent wherever a caller holds no watches.
export function StatusIcon({ session, watching }: { session: any; watching?: string | null }) {
  const state = sessionRunStateOf(session);
  const fontSize = 16;
  // First, and outside the generating gate — see `statusLabel`. The glyph and the label branch in
  // the same order on purpose: they are read together on one row.
  if ((session.pendingApprovals ?? 0) > 0)
    return (
      <Tooltip title={waitingLabel(session)}>
        <PauseCircleOutlined style={{ color: 'var(--warning-solid)', fontSize }} />
      </Tooltip>
    );
  // Under review: a clock in the neutral tone, beside the row's line in the same place (§5 N3).
  if (session.confirmationUnderReview)
    return (
      <Tooltip title={UNDER_REVIEW}>
        <ClockCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  if (state === 'SUCCEEDED')
    return (
      <Tooltip title="Succeeded">
        <CheckCircleFilled style={{ color: 'var(--success-solid)', fontSize }} />
      </Tooltip>
    );
  // Same spinner as Running — it is genuinely working — with the honest tooltip. A separate
  // glyph would read as a fourth outcome for what is still work in progress.
  if (waitingNoticeFor(session))
    return (
      <Tooltip title={startingTitle(session)}>
        <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize }} />
      </Tooltip>
    );
  if (isGenerating(session, state)) {
    return <RunningStatusIcon />;
  }
  if (state === 'AWAITING_INPUT') {
    const work = parkedWorkLabel(session);
    // A sub-workspace is the workspace itself still working, so it keeps the working spinner. A
    // background shell isn't: workspaces routinely leave a dev server or watcher up, and it never
    // exits, so spinning at it would mark the session busy for the rest of its life and drown
    // out the sessions that really are working. It gets a muted terminal-prompt glyph (the native
    // port's SF `terminal`) and keeps its label — breathing while a job is in flight (a bg_run
    // that will end), still while the only thing up is a `service`. Never spinning: the shape and
    // the colour keep meaning "not the agent working", and only the motion says "work is happening
    // here", which is the one claim a left-up process cannot make.
    //
    // Parked on a live watch, below a sub-workspace and above a left-up process: a wake is coming,
    // so neither the reply bubble nor the terminal fits — a watch is not a process (contract §9.2).
    // The strip's eye, still, because nothing here is running.
    if (watching && work?.kind !== 'subagent')
      return (
        <Tooltip title={watching}>
          <EyeOutlined style={{ color: 'var(--text-3)', fontSize }} />
        </Tooltip>
      );
    if (work)
      return (
        <Tooltip title={work.text}>
          {work.kind === 'subagent' ? (
            <LoadingOutlined spin style={{ color: 'var(--brand)', fontSize }} />
          ) : (
            <CodeOutlined
              className={work.active ? 'status-glyph-active' : undefined}
              style={{ color: 'var(--text-3)', fontSize }}
            />
          )}
        </Tooltip>
      );
    return (
      <Tooltip title="Waiting for your reply">
        <MessageOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  }
  if (state === 'FAILED') {
    // A failure the server is about to undo by itself is not red: the situation is handled and
    // nothing is being asked of the reader (the same reasoning the transcript's AutoRetryCard
    // draws neutral until the retries run out). Red would put it in the list's "look at me" set
    // for the 30 seconds before it fixes itself.
    if (sessionRetryPending(session))
      return (
        <Tooltip title="Retrying — the run resumes on its own">
          <ClockCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
        </Tooltip>
      );
    const err: string = typeof session.error === 'string' ? session.error : '';
    if (err.toLowerCase().includes('offline'))
      return (
        <Tooltip title="Disconnected — runner went offline">
          <DisconnectOutlined style={{ color: 'var(--text-3)', fontSize }} />
        </Tooltip>
      );
    return (
      <Tooltip title={err || 'Failed'}>
        <CloseCircleFilled style={{ color: 'var(--error)', fontSize }} />
      </Tooltip>
    );
  }
  if (state === 'INTERRUPTED')
    return (
      <Tooltip title="Interrupted">
        <MinusCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  // Every deliberate end — filed, ended, stopped, task-driven — draws the same neutral check.
  // Grey rather than green because the run reported no verdict of its own, and one glyph
  // rather than three because resume eligibility never depended on which act ended it.
  if (state === 'ENDED')
    return (
      <Tooltip title="Ended">
        <CheckCircleOutlined style={{ color: 'var(--text-3)', fontSize }} />
      </Tooltip>
    );
  // PENDING — waiting for an active turn slot
  return (
    <Tooltip title={queuedTitle(session)}>
      <ClockCircleOutlined style={{ color: 'var(--scrollbar-hover)', fontSize }} />
    </Tooltip>
  );
}

function SessionStatusCard({ card }: { card: LocalStatusCard }) {
  return (
    <div className="chat-status-card" role="status" aria-label="Session status">
      <div className="chat-status-head">
        <span className="chat-status-icon" aria-hidden="true">
          <InfoCircleOutlined />
        </span>
        <span>Status</span>
      </div>
      <div className="chat-status-grid">
        {card.rows.map((row) => (
          <div className="chat-status-row" key={row.label}>
            <span className="chat-status-label">{row.label}</span>
            <span className="chat-status-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Placeholder for a session whose transcript hasn't arrived yet. Mirrors the real shapes — a
// right-aligned user bubble, then a full-width assistant block — so the pane reads as a
// conversation loading rather than as an empty one, and settles without a jarring reflow when
// the events land. Static: it is on screen for a few hundred ms, so no measuring or randomness.
function TranscriptSkeleton() {
  return (
    <div className="chat-skeleton" aria-busy="true" aria-label="Loading conversation">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="chat-skeleton-user">
            <span className="chat-skeleton-line" style={{ width: '58%' }} />
          </div>
          <div className="chat-skeleton-assistant">
            <span className="chat-skeleton-line" style={{ width: '92%' }} />
            <span className="chat-skeleton-line" style={{ width: '97%' }} />
            <span className="chat-skeleton-line" style={{ width: '74%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * How long the wait this notice describes has been going, ticking once a second.
 *
 * Its own component so the second hand costs one leaf re-render rather than re-rendering the
 * whole workspace — and the transcript inside it — every second a session is starting.
 *
 * The elapsed time is the only thing on these notices that separates the ordinary case they were
 * written for (a cold start, a few seconds) from the one that made them useless (an engine
 * compacting a conversation it can no longer fit, which is minutes and can retry). Neither the
 * copy nor the spinner can: both read identically at 3s and at 30m.
 */
function WaitElapsed({ since }: { since?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const label = waitElapsedLabel(since, now);
  return label ? <span className="chat-wait-elapsed">{label}</span> : null;
}

/**
 * `</>` — the glyph the native composer's `+` menu gives Command (SF Symbols
 * `chevron.left.forwardslash.chevron.right`). `@ant-design/icons` v6 has no slash-bracket: its
 * `CodeOutlined` draws a terminal box, which is the glyph native Shell carries, so the two are not
 * interchangeable and this one is drawn here. 1em square, so it takes the size its row asks for.
 *
 * `className` is not decoration: the menu clones the icon with its own slot class, and a component
 * that drops it renders a glyph with no size and no gap — the one thing a menu glyph cannot be.
 */
function SlashCommandIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      data-glyph="slash-command"
      viewBox="0 0 20 20"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.7 6.3 3.2 10l3.5 3.7M13.3 6.3 16.8 10l-3.5 3.7M11.3 4.2 8.7 15.8" />
    </svg>
  );
}

/**
 * What the send button turns into while a turn runs: a filled square, as native draws it
 * (`stop.circle.fill`). `BorderOutlined` is an outline, and inside a filled circle an outline reads
 * as an empty box rather than as Stop.
 */
function StopSquareIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 12"
      width="0.8em"
      height="0.8em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="10" height="10" rx="2.4" />
    </svg>
  );
}

/** What withdrawing a queued wake costs: said beside the action, and again when it asks to confirm. */
const WAKE_WITHDRAW_CONSEQUENCE =
  "If withdrawn, this session is not woken this time, and the watch won't send it again.";

/**
 * The line under a message in the queued tail — the one thing that says which of the two kinds
 * the server filed it as, and where the way out of it is offered.
 *
 * A queued message is waiting for its own turn: nothing has read it, so it can still be taken
 * back. A steer is already on its way into the turn in progress, and the engine may be reading it
 * as we ask — the server refuses to withdraw one (409, "being written into the running turn"), so
 * offering Cancel would be offering a button that always fails. `placement` is the server receipt,
 * never a local guess.
 *
 * Once delivery has settled undelivered, both of those stop being true. Nothing read the message
 * and nothing will; the row is a durable statement about a boundary that has passed. So it is the
 * one state that needs the opposite of Cancel's caution: the text exists nowhere else, and with no
 * action offered the bubble is a dead end that outlives the conversation it failed under.
 *
 * A wake a watch queued leaves through the same door, but it was never anyone's to take back:
 * withdrawing it dead-letters the watch's delivery (WAKE_WITHDRAWN), so the session is not woken
 * and the watch does not send it again. The action says what it does, and the line what follows.
 */
export function QueuedTurnMeta({
  placement,
  delivery,
  deliveryCode,
  deliveryReason,
  wake,
  onCancel,
  onPutBack,
}: {
  placement: Extract<SessionTurnPlacement, 'steer' | 'queued'>;
  delivery?: 'failed' | 'unconfirmed';
  deliveryCode?: string;
  deliveryReason?: string;
  /** The turn is a wake a watch queued (lib/watches `parseWatchWake`), not a message anyone typed. */
  wake?: boolean;
  onCancel: () => void;
  onPutBack?: () => void;
}) {
  const label = delivery === 'failed'
    ? 'Not delivered'
    : delivery === 'unconfirmed'
      ? 'Delivery could not be confirmed'
    : placement === 'steer'
      ? steerDeliveryState(undefined).label
      : 'Queued for next turn';
  const why = delivery != null
    ? deliveryFailureExplanation(deliveryCode, deliveryReason)
    : wake && placement === 'queued'
      ? WAKE_WITHDRAW_CONSEQUENCE
      : undefined;
  return (
    <span className="chat-queued-meta" title={deliveryReason}>
      <span className={`chat-queued-tag${delivery != null ? ' chat-queued-tag-failed' : ''}`}>
        {label}
      </span>
      {why && <span className="chat-queued-why">{why}</span>}
      {delivery == null
        ? placement === 'queued' && <a onClick={onCancel}>{wake ? 'Withdraw wake' : 'Cancel'}</a>
        : onPutBack && <a onClick={onPutBack}>Put back in the composer</a>}
    </span>
  );
}

// Remembers the session the user last had open per workspace (workspace id → session id). Switching
// away to another workspace and back reopens that conversation instead of the workspace's most-recent
// one. In-memory only (a full reload deep-links via the URL) and at module scope so it survives
// WorkspaceView remounts across runner switches.
const lastSessionByWorkspace = new Map<string, string>();

export function WorkspaceView({ runner }: { runner: Runner }) {
  const { modal } = AntApp.useApp();
  const message = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Merge and Commit finish asynchronously on a runner heartbeat. Keep accepted operations by
  // session id so their result continues polling even if the user opens another conversation.
  const pendingOperationSeq = useRef(0);
  const [pendingSessionOperations, setPendingSessionOperations] = useState<
    Record<string, PendingSessionOperation>
  >({});
  // The signed-in user, for the account-synced defaults (Effort and — since the mode moved off
  // Workspace — the permission Mode a new session starts in). Cached/deduped with the nav footer.
  const me = useQuery(meQuery());
  const accountDefaultPermissionMode = me.data?.preferences?.defaultPermissionMode;
  // Configured providers (custom slugs borrowing a built-in runtime) merged into the composer's
  // model list + context-window sizing when the open session/workspace uses one. Cached/deduped
  // app-wide by React Query; empty until it loads (then the model pill's options fill in).
  const configuredProvidersQuery = useQuery(providersQuery());
  // The user's account pools, which that catalogue doesn't list: each is one more provider to pick
  // and run on, with the Claude CLI's own models (poolsAsProviders), and each session on one runs on
  // one of its accounts — the account the status bar names. The shared pools they are in come first,
  // drawn the same way with their keys as members (sharedPoolAsProviderPool): Codex, on a key.
  const accountPoolsQuery = useQuery(providerPoolsQuery());
  const sharedPools = useQuery(sharedPoolsQuery());
  const accountPools = useMemo(
    () => [...(sharedPools.data ?? []).map(sharedPoolAsProviderPool), ...(accountPoolsQuery.data ?? [])],
    [sharedPools.data, accountPoolsQuery.data],
  );
  const configuredProviders = useMemo(
    () => [...(configuredProvidersQuery.data ?? []), ...poolsAsProviders(accountPools)],
    [configuredProvidersQuery.data, accountPools],
  );
  const configuredProvidersLoaded =
    configuredProvidersQuery.data !== undefined && !accountPoolsQuery.isPending && !sharedPools.isPending;
  // The picked session lives in the URL (/sessions/:id, a base62 public id) so
  // it deep-links and survives a refresh; selecting a session = navigation.
  // Decode once here; everything downstream works with the raw session UUID.
  const selectedId = routeId(useMatch('/sessions/:id')?.params.id);
  const openProjectId = routeId(searchParams.get('project'));
  const projectView = openProjectId ? (searchParams.get('view') === 'completed' ? 'completed' : 'open') : null;
  // Latest selectedId, readable from async callbacks (loadOlder) to bail if the user has
  // switched sessions since the request was issued — so a late page never lands in the wrong
  // transcript. Assigning during render is safe for a "current value" ref.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // The record a link opened the session at (`/sessions/<id>?at=<record>`, lib/transcriptDeepLink),
  // in its public spelling, or null. Mirrored for the session effect, which reads the one it opens
  // with and must not re-run — re-seeding the whole window — when only this changes.
  const recordAt = recordAtOf(searchParams);
  const recordAtRef = useRef(recordAt);
  recordAtRef.current = recordAt;
  // Inline header-title rename: double-click swaps the title for an input. `editingTitle`
  // gates the editor, `titleDraft` holds the in-progress text, `cancelTitleEdit` lets
  // Escape skip the blur-commit. Switching sessions closes any open editor (effect below).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const cancelTitleEdit = useRef(false);
  // Size the rename input to its text (via an off-screen mirror) so the underline hugs the
  // title instead of spanning the whole header; CSS caps it at the available width.
  const titleMirrorRef = useRef<HTMLSpanElement>(null);
  const [titleInputW, setTitleInputW] = useState(0);
  useLayoutEffect(() => {
    if (editingTitle) setTitleInputW((titleMirrorRef.current?.offsetWidth ?? 0) + 2);
  }, [editingTitle, titleDraft]);
  // /workspaces/<id> names the workspace this console is scoped to: the picker is locked
  // to it and the session list is filtered to that workspace's conversations.
  // /workspaces/<id>/new is the "compose a new session" draft state (the splat is 'new').
  // Two patterns, one meaning: `agents` is the pre-rename URL people still have bookmarked.
  const workspacesMatch = useMatch('/workspaces/:id/*');
  const agentsMatch = useMatch('/agents/:id/*');
  const workspaceMatch = workspacesMatch ?? agentsMatch;
  const lockedWorkspaceId = routeId(workspaceMatch?.params.id);
  const composingRoute = (workspaceMatch?.params['*'] ?? '') === 'new';
  // A conversation opened from the session list stamps that on its history entry, and the phone's
  // ← reads it back: with the list one entry behind, going back can be a real back, so
  // list → conversation → ← leaves the history where it started instead of stacking a third entry.
  // Stamped only while the list is the screen being left (⌘N from an open conversation is not),
  // and absent on a deep-linked conversation — which has no entry behind it to return to.
  //
  // Both halves read the browser's own URL and history entry at the moment they are asked, not the
  // route this render closed over. <BrowserRouter> wraps every location update in a transition, so
  // useLocation() trails the real entry by a render: long enough for a stamp to be written from the
  // route we just left, and for the ← to misread the entry it is standing on.
  const stampFromList = (): { paneFromList: true } | undefined =>
    showsConversation(window.location.pathname) ? undefined : { paneFromList: true };
  const arrivedFromList = (): boolean =>
    (window.history.state?.usr as { paneFromList?: boolean } | null)?.paneFromList === true;
  // Below the mobile breakpoint the two panes stack one-at-a-time; a couple of layout
  // choices (the auto-open redirect, the in-pane back button) key off this.
  const isMobile = useIsMobile();
  // Installed-PWA / standalone is the only mode where ⌘N actually reaches the page
  // (a normal tab hands it to the browser). Gate the on-button shortcut hint on it.
  const isStandalone = useMediaQuery('(display-mode: standalone)');
  // Touch devices have no hover, so a tap that shows a Tooltip never gets the mouseleave
  // that dismisses it — the bubble lingers on screen (e.g. an "Unpin" tip stuck after a
  // pin tap). Suppress these tooltips where hover is unavailable; every gated control
  // already labels itself.
  // The same reading decides how a menu opens a level down: on hover where the pointer can
  // hover, on a tap where it cannot (the composer model menu's `triggerSubMenuAction`).
  const canHover = useMediaQuery('(hover: hover)');
  const hoverTipOpen = canHover ? undefined : false;
  const [text, setText] = useState('');
  // `#`-references the user has picked in this draft: token → what it points at. Kept beside the
  // draft rather than in the URL or the server, because it only has to survive as long as the
  // text it annotates — a token the user edits stops matching and simply travels as prose.
  const [composerRefs, setComposerRefs] = useState<ReferenceMap>({});
  // The textarea's scroll offset, mirrored so the chip layer stays in step once the draft passes
  // its auto-grow cap.
  const [composerScroll, setComposerScroll] = useState(0);
  // Composer history cursor: -1 = editing the live draft; otherwise an index into the
  // session's stored history. `histDraft` stashes what was typed before recall started,
  // so stepping back past the newest entry restores it (shell-style).
  const [histIdx, setHistIdx] = useState(-1);
  const [histDraft, setHistDraft] = useState('');
  // Composer drafts are isolated per target — each session by its id, the new-session
  // compose under the 'new' key — so switching sessions never drags one composer's text
  // into another, and the new-session draft survives leaving and coming back. textRef
  // mirrors `text` so the switch effect (below) can stash the *outgoing* draft without
  // re-running on every keystroke; prevDraftKey tracks which target `text` belongs to.
  const draftKey = selectedId ?? 'new';
  const drafts = useRef<Map<string, string>>(new Map());
  const textRef = useRef('');
  const prevDraftKey = useRef(draftKey);
  const [mode, setMode] = useState('Auto');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const modelPreferenceMut = useMutation({
    // Keep rapid picks in order, including across a composer remount.
    scope: { id: 'model-preferences' },
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      api('/users/me/preferences', {
        method: 'PATCH',
        body: { defaultModels: { [provider]: model } },
      }),
  });
  // Runtime catalogs and configured providers arrive asynchronously. Track whether the user has
  // touched Model within the current draft/session context so a late default can fill an untouched
  // picker without overwriting an explicit choice. Context changes deliberately reset dirty.
  const modelSeedState = useRef<ContextSeedState>({
    contextKey: '',
    dirty: false,
  });
  const modeSeedState = useRef<ContextSeedState>({
    contextKey: '',
    dirty: false,
  });
  const effortSeedState = useRef<ContextSeedState>({
    contextKey: '',
    dirty: false,
  });
  // Seeded from the account default by the effect below once `me` loads (mirrors how Model/Mode
  // seed via effects); '' = model default until then.
  const [effort, setEffort] = useState('');
  // Whether the draft (or the ended session about to be resumed) asks for Claude Code's fast
  // lane. No seed-state ref like the three above: those exist because a workspace or account
  // default can arrive late and clobber an untouched pick, and fast mode has neither — it is
  // per-session, and off is what a session that never asked for it runs with.
  const [fastMode, setFastMode] = useState(false);
  // Which product lifecycle slice of the session list to show.
  const [view, setView] = useState<SessionView>('open');
  // Optional narrowing/sectioning of the list by tag, mirroring the iOS drawer's filter menu.
  // Both are view-local UI state (not persisted) — the same as the native list.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupByTag, setGroupByTag] = useState(false);
  // The Pinned section folds to its heading, as Notes' Pinned does (and as on iOS). Unlike those two
  // it is persisted, so a reload doesn't unfold it.
  const [pinnedCollapsed, setPinnedCollapsed] = useState(
    () => localStorage.getItem(PINNED_COLLAPSED_KEY) === '1',
  );
  const togglePinned = (): void => {
    const next = !pinnedCollapsed;
    setPinnedCollapsed(next);
    localStorage.setItem(PINNED_COLLAPSED_KEY, next ? '1' : '0');
  };
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null); // session row whose action menu is open
  // Touch swipe actions for session rows: on mobile the row's actions sit behind a swipe,
  // laid out like the iOS list (lib/sessionSwipe) — swipe right
  // for Complete / Move to Open + Pin, swipe left for Delete.
  const [swipeOpen, setSwipeOpen] = useState<{ id: string; side: SwipeSide } | null>(null); // row held open by a swipe
  // The row under a finger drag: its live offset (px; negative = leftward), and whether releasing
  // now would be a full swipe.
  const [swipeDrag, setSwipeDrag] = useState<{ id: string; dx: number; armed: boolean } | null>(null);
  // offset (the live position) lives on the ref so touchend reads it synchronously: React defers
  // continuous touchmove state, so swipeDrag state can be stale when discrete touchend fires.
  const swipeRef = useRef<{
    session: any;
    id: string;
    x: number;
    y: number;
    axis: '' | 'h' | 'v';
    offset: number;
    from: SwipeSide | null;
    geometry: SwipeGeometry;
  } | null>(null);
  const swipeClickGuard = useRef(false); // eat the click that trails a horizontal swipe
  const [shareOpen, setShareOpen] = useState(false); // share dialog for the open session
  // A row's Share action opens the share dialog for that row rather than for the open session.
  const [shareRowId, setShareRowId] = useState<string | null>(null);
  // The session the Move dialog is open for: a row's, or the open conversation's.
  const [moveTarget, setMoveTarget] = useState<(MoveDialogSession & {
    workspace?: { id: string; name: string };
  }) | null>(null);
  // New Folder… and Rename…'s inline name field (`id` null for a new folder), and the folder row
  // whose ⋯ menu is open — it keeps the row's hover look while it is.
  const [folderEdit, setFolderEdit] = useState<{
    id: string | null;
    draft: string;
    error: string | null;
    saving: boolean;
  } | null>(null);
  const [folderMenuOpenId, setFolderMenuOpenId] = useState<string | null>(null);
  // The field's latest state for its handlers: a blur fired as Return or Esc unmounts the field
  // reads it closed and saves nothing, and a second Return can't race the first save.
  const folderEditRef = useRef(folderEdit);
  folderEditRef.current = folderEdit;
  const folderSaving = useRef(false);
  // Controlled because the multi-select tag items stay open after a choice; ordinary actions
  // close it explicitly (Ant Dropdown otherwise keeps every item open in multiple-select mode).
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // React Query publishes isPending through a batched render; this synchronous lock closes the
  // small window where a second full-selection PUT could otherwise start before items disable.
  const tagSaveInFlight = useRef(false);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [events, setEvents] = useState<RunEvent[]>([]);
  // `events` is replaced in an effect after navigation. Keep its owner explicit so a render in
  // between cannot treat the previous session's transcript as the newly selected session's.
  const [eventsSessionId, setEventsSessionId] = useState<string | null>(selectedId);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]); // pending tool-permission requests
  // An armed reply: the next composer send carries what is typed to one card's business instead of
  // being an ordinary message, and the card that armed it stays until then. Five presses arm it — a
  // question's "Chat about this", a decline of one of Orbit's own asks, the confirmation card's
  // send-back, the settlement card's "Chat about this", the project settlement card's, and the
  // evidence card's — because all six want a sentence, and the composer is where a sentence is
  // typed. Null = normal send; `target` is the only thing that differs, and it is where the send
  // goes.
  //
  // `planChange` and `projectSettlement` are the two that go through no door at all. The other four
  // answer a call that is blocking on them; there the agent is idle and nothing is pending, so the
  // send is an ordinary turn with the facts it is about carried in front of it (`context`).
  // `coordinatorChat` is the exception and blocked-merge cards' "Chat about this"
  // (`lib/coordinatorChat`), and goes through no door either: what it carries is the card's facts,
  // for this conversation's coordinator to act on with the doors it has.
  const [replyTo, setReplyTo] = useState<{
    target:
      | { kind: 'approval'; id: string }
      | { kind: 'ownerConfirmation'; taskId: string; requestId: string }
      // `decidingSessionId`: the session the card it was armed from decides as, when that is not
      // this one (`evidenceDecidingSession`) — a dispatched task's card drawn in its run.
      | { kind: 'evidenceDecision'; taskId: string; evidenceRevision: string; decidingSessionId: string | null }
      | { kind: 'planChange'; projectId: string; criteriaDigest: string }
      | { kind: 'coordinatorChat'; projectId: string; about: ChatAbout };
    /** What the reply bar says it is about to answer, whole — built by whoever armed it. */
    banner: string;
    /** What the empty composer asks for while this is armed. */
    placeholder: string;
    /** Carried ahead of the typed message by a send that starts an ordinary turn. */
    context?: string;
  } | null>(null);
  const [streamingText, setStreamingText] = useState(''); // live assistant text from text_delta
  const [streamingThink, setStreamingThink] = useState(''); // live thinking from thinking_delta
  // When the stretch of reasoning on screen began: the live row counts up from it, and the row it
  // settles into states how long it took. Client-side only — `thinking_delta` is broadcast and
  // never persisted, so a reload has no clock to recover this from (see lib/thinkingDraft).
  const [thinkStartedAt, setThinkStartedAt] = useState<number | null>(null);
  // Mirrors of both, for the SSE handler: it is registered once per session and would otherwise
  // close over the values of the render that registered it.
  const streamingThinkRef = useRef('');
  const thinkStartedAtRef = useRef<number | null>(null);
  const [liveToolOutputState, setLiveToolOutputState] = useState<SessionLiveToolOutputs>({
    sessionId: selectedId,
    outputs: EMPTY_LIVE_TOOL_OUTPUTS,
  });
  // Broadcast-only progress of the workspace's background agents and workflows — the same kind of
  // side channel as the shell snapshots above, and scoped to its session the same way.
  const [liveTaskProgressState, setLiveTaskProgressState] = useState<SessionLiveTaskProgress>({
    sessionId: selectedId,
    progress: EMPTY_LIVE_TASK_PROGRESS,
  });
  // The seq the stream was at when the current stretch of generation began, so the transcript can
  // render the drafts where they started rather than always last. A ref, not state: it only ever
  // moves alongside a draft update, so the render that shows the new text already reads the new
  // anchor — and keeping it out of state means a chunk doesn't re-render anything extra.
  const streamAnchorRef = useRef<number | null>(null);
  const [idle, setIdle] = useState(false); // session is AWAITING_INPUT (a new turn is accepted)
  const [queued, setQueued] = useState<QueuedTurn[]>([]); // messages sent while a turn was running
  const queuedRef = useRef<QueuedTurn[]>(queued);
  queuedRef.current = queued;
  const [queuedSessionId, setQueuedSessionId] = useState<string | null>(selectedId);
  // A normal idle/new-session send is accepted before the runner emits its durable `user` event.
  // Keep that acknowledged message visible in the gap; queued/steered follow-ups stay in `queued`
  // above because their status + Cancel affordance are meaningful rather than transport noise.
  const [acceptedUserTurns, setAcceptedUserTurns] = useState<AcceptedUserTurn[]>([]);
  const acceptedUserTurnsRef = useRef<AcceptedUserTurn[]>(acceptedUserTurns);
  acceptedUserTurnsRef.current = acceptedUserTurns;
  const [localStatusCards, setLocalStatusCards] = useState<LocalStatusCard[]>([]);
  // The apiserver's authoritative background-shell list (all launches + output recovered from the
  // workspace's Read polls). The loaded event window only holds recent launches, so the tray merges
  // this complete set with its live-derived overlay — see BackgroundShellsTray.
  const [serverBgShells, setServerBgShells] = useState<BgShell[]>([]);
  // Per-session cache of the server /background scan. The tray is cleared to [] on every switch, so
  // the throttle in the SSE effect repopulates from here (not just skips) when it's still fresh.
  const bgCacheRef = useRef<Map<string, { at: number; shells: BgShell[] }>>(new Map());
  const [images, setImages] = useState<ComposerImage[]>([]); // images staged in the composer
  // One key per logical send, retained across an uncertain network/5xx result. A changed wire
  // payload mints another key; a verbatim retry lets the server return its committed receipt.
  const sendOperationRef = useRef<LogicalSendToken | null>(null);
  const resolveConflictOperationRef = useRef<LogicalSendToken | null>(null);
  const resolveCommitOperationRef = useRef<LogicalSendToken | null>(null);
  // Images already sent, keyed by their turnId. The runner echoes only the turn's text,
  // so these local previews are joined back into the user bubble (and the queued bubble)
  // to show the sent image in the transcript. Object URLs are revoked on session switch.
  const [turnImages, setTurnImages] = useState<Record<string, TurnImage[]>>({});
  const seen = useRef<Set<number>>(new Set());
  // Per-session transcript cache (mount-scoped): switching seeds events from here for
  // an instant paint and resumes the SSE just past the cached seq, instead of replaying
  // each session's full history from seq 0 on every visit. Stores the older-pagination
  // boundary too, so a reopened session keeps its "load earlier" state.
  const transcriptCache = useRef<Map<string, TranscriptCacheEntry>>(new Map());
  // Live mirror of `events`, so the SSE handler (append) and loadOlder (prepend) both mutate
  // one source of truth without racing stale closures — see the load effect below.
  const accRef = useRef<RunEvent[]>([]);
  // Tail-first lazy loading state for the open session. Refs drive the (deps-free) scroll
  // handler; loadingOlder (state) drives the top "loading earlier" spinner.
  const oldestSeqRef = useRef<number | null>(null); // earliest loaded seq
  const hasMoreOlderRef = useRef(false); // older events exist before oldestSeq on the server
  // The in-flight page request, if any: it both guards against a second one and lets a caller
  // that needs to know when older content has landed (⌘F's "search earlier") await the one
  // already running instead of being told "no".
  const loadingOlderRef = useRef<Promise<boolean> | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Render mirror of hasMoreOlderRef, refreshed by measure() the way setAtBottom is: it decides
  // whether the top of the transcript offers the way back to the first message.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  // Set while "Jump to the beginning" is walking the pages back, so each page it asks for is
  // stamped as one that wants the top (see prependAnchorRef).
  const jumpingToStartRef = useRef(false);
  // A window opened at a record (`?at=`) stops short of the tail: this is the `after=` cursor for the
  // page newer than what is loaded, and it is non-null exactly while that is so. The live stream stays
  // closed meanwhile — its events belong after the gap, not at the bottom of this window — and opens
  // once paging down reaches the latest event (joinLiveRef) or the reader jumps there (backToLatestRef).
  const newerCursorRef = useRef<number | null>(null);
  const [detached, setDetached] = useState(false); // render mirror of newerCursorRef !== null
  const loadingNewerRef = useRef<Promise<boolean> | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  // The record to bring into view and mark once its page has rendered; the tick re-asks when the page
  // is already on screen, where nothing else would re-render.
  const pendingRecordRef = useRef<{ sessionId: string; seq: number } | null>(null);
  const [recordTick, setRecordTick] = useState(0);
  // The `?at=` already followed (`<session> <record>`), so one link is followed once, not on every render.
  const followedRecordRef = useRef<string | null>(null);
  // Set by the session effect, which owns the stream: open a record of the session already open, join
  // the live stream once a detached window reaches the latest event, and trade a detached window for
  // the tail.
  const openRecordRef = useRef<((recordId: string) => void) | null>(null);
  const joinLiveRef = useRef<(() => void) | null>(null);
  const backToLatestRef = useRef<(() => void) | null>(null);
  // True from the moment a session with no cached transcript is selected until its tail page
  // lands (or gives up). Drives the skeleton: without it an unvisited session paints a blank
  // pane for the whole fetch, since an ended session matches none of the empty-state notes.
  const [seeding, setSeeding] = useState(false);
  // Set by loadOlder just before it prepends a page; a layout effect reads it to compensate
  // scrollTop so the viewport stays put instead of jumping when older content grows above. `toTop`
  // marks a page fetched by the walk to the beginning, which wants the top rather than the
  // position it was at — carried on the anchor, not read off the walk's flag when the page lands,
  // because the last page commits after the walk has already finished.
  const prependAnchorRef = useRef<{ prevHeight: number; prevTop: number; toTop: boolean } | null>(null);
  // Re-opens the transcript SSE after a `final` event paused it and the session was
  // resumed in place (set by the SSE effect, called by the liveness watcher below).
  const resumeStreamRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the left session-list column, for arrow-key scrolling

  // Project pages mix Open and Completed; their rows use each session's lifecycle.
  const rowView = projectView ?? view;
  const sessionRowView = useCallback((session: SessionListItem): SessionView => openProjectId
    ? sessionLifecycleStateOf(session).toLowerCase() as SessionView : rowView, [openProjectId, rowView]);
  const onRowTouchStart = (e: ReactTouchEvent, session: any, canFullSwipe: boolean, projectId?: string): void => {
    if (!isMobile) return;
    const t = e.touches[0];
    // Clear any guard left set by a prior swipe that fired no trailing click, so the next
    // genuine tap isn't swallowed.
    swipeClickGuard.current = false;
    const id = projectId ?? session.id;
    const from = swipeOpen && swipeOpen.id === id ? swipeOpen.side : null;
    const geometry = projectId
      ? { leadingWidth: SWIPE_ACTION_WIDTH, trailingWidth: SWIPE_ACTION_WIDTH, fullSwipeAt: null, maxOffset: SWIPE_ACTION_WIDTH + 20 }
      : swipeGeometry(sessionRowView(session), e.currentTarget.getBoundingClientRect().width, canFullSwipe);
    swipeRef.current = {
      session,
      id,
      x: t.clientX,
      y: t.clientY,
      axis: '',
      offset: restingOffset(from, geometry),
      from,
      geometry,
    };
  };
  const onRowTouchMove = (e: ReactTouchEvent): void => {
    const st = swipeRef.current;
    if (!st) return;
    const t = e.touches[0];
    const mx = t.clientX - st.x;
    const my = t.clientY - st.y;
    // Lock the axis once the finger clears a small deadzone; a vertical intent yields to the
    // list's own scroll and never drags the row.
    if (st.axis === '') {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      st.axis = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      if (st.axis === 'h') {
        setSwipeOpen((cur) => (cur && cur.id !== st.id ? null : cur)); // starting a swipe shuts any other open row
      }
    }
    if (st.axis !== 'h') return;
    st.offset = dragOffset(st.from, mx, st.geometry); // synchronous truth for the touchend decision
    setSwipeDrag({ id: st.id, dx: st.offset, armed: isFullSwipe(st.offset, st.geometry) });
  };
  const onRowTouchEnd = (): void => {
    const st = swipeRef.current;
    swipeRef.current = null;
    if (!st || st.axis !== 'h') {
      setSwipeDrag(null);
      return;
    }
    swipeClickGuard.current = true; // the trailing click (if any) must not navigate
    // Reading st.offset (a ref) avoids the stale swipeDrag state that React's deferred touchmove
    // updates would otherwise leave at touchend.
    const { open, fullSwipe } = settleSwipe(st.from, st.offset, st.geometry);
    setSwipeOpen(open ? { id: st.id, side: open } : null);
    setSwipeDrag(null);
    if (fullSwipe) runSwipeAction(sessionSwipeActions(sessionRowView(st.session)).leading[0], st.session);
  };
  // An OS-interrupted gesture (system swipe, incoming call) fires touchcancel, not touchend —
  // drop the drag and let the row settle back to its committed open/closed state.
  const onRowTouchCancel = (): void => {
    swipeRef.current = null;
    setSwipeDrag(null);
  };
  // The turn the answer currently in view belongs to, surfaced as a sticky bar when a long answer
  // has pushed it off the top — so what is being answered stays findable. null hides it. `label`
  // says whose turn it was: the person's, or the wake's own title where nobody typed it.
  const [stuck, setStuck] = useState<
    { seq: string | null; label: string; text: string; loading?: boolean } | null
  >(null);
  // The exception cards scrolled wholly above the viewport, by item id and space-joined so an
  // unchanged answer is no re-render: which way the pinned line's press goes to reach one.
  const [openItemsAbove, setOpenItemsAbove] = useState('');
  // Smart auto-scroll: only keep pinned to the bottom when the user is already there, so
  // reading history (or jumping to the sticky prompt) isn't yanked back by streaming updates.
  const atBottomRef = useRef(true);
  // A bar-opened review stays at its preview until the reader navigates or sends again.
  const reviewPositionHeldRef = useRef(false);
  // Render mirror of atBottomRef: drives the floating "jump to bottom" button, which shows
  // while the user has scrolled up off the live tail (and while `stranded`). (The ref alone
  // can't re-render.)
  const [atBottom, setAtBottom] = useState(true);
  // Pinned, but come to rest with the tail out of view: the button's other reason to show. The pin
  // lets go on a scroll UP alone (tailPinning.ts), so a tail that left the view any other way — the
  // last card opened under a reader at the bottom, a link card landing — still reads as at the
  // bottom. Decided by measure() once that has lasted STRANDED_AFTER_MS, on strandTimerRef, which
  // stays set until the tail is back in view or a content update restarts the wait.
  const [stranded, setStranded] = useState(false);
  const strandTimerRef = useRef<number | undefined>(undefined);
  // Last observed scroll geometry, so the scroll handler can tell a genuine user scroll-up from a
  // programmatic re-pin, a late scroll event fired after streaming grew the container, or the
  // scrollTop the browser clamps when content gets SHORTER (see tailPinning.ts).
  const lastSampleRef = useRef<TailScrollSample>(TAIL_SAMPLE_ZERO);
  // When the reader last had their own hand on the scroller (wheel, finger, scrollbar, arrow key).
  // The browser reports no scroll phase, so this is the evidence that a falling scrollTop is theirs.
  const readerInputAtRef = useRef(0);
  // Tail-first lazy loading: pull in the next older page when the user scrolls near the top.
  // Guarded to one request in flight; prepends the page and stamps prependAnchorRef so the
  // layout effect below holds the viewport steady while older content grows above it.
  // Resolves true when events were actually prepended, so an awaiting caller can tell "there's
  // more history now" from "that was the end of it".
  const loadOlder = useCallback((): Promise<boolean> => {
    if (loadingOlderRef.current) return loadingOlderRef.current;
    if (!selectedId || !hasMoreOlderRef.current) return Promise.resolve(false);
    const before = oldestSeqRef.current;
    if (before == null) return Promise.resolve(false);
    setLoadingOlder(true);
    const inFlight = getSessionEventPage(selectedId, { before, limit: OLDER_PAGE })
      .then((page) => {
        if (selectedIdRef.current !== selectedId) return false; // user switched sessions mid-fetch
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) if (typeof e.seq === 'number') seen.current.add(e.seq);
        if (fresh.length) {
          const el = scrollRef.current;
          if (el) {
            prependAnchorRef.current = {
              prevHeight: el.scrollHeight,
              prevTop: el.scrollTop,
              toTop: jumpingToStartRef.current,
            };
          }
          accRef.current = [...fresh, ...accRef.current];
          setEvents(accRef.current);
        }
        oldestSeqRef.current = page.events.length ? page.events[0].seq : before;
        hasMoreOlderRef.current = page.hasMore;
        // A window opened at a record is not cached: the cache is a window that ends at the tail,
        // which a reopen resumes the live stream from.
        if (newerCursorRef.current === null) {
          transcriptCache.current.set(selectedId, {
            events: accRef.current,
            oldestSeq: oldestSeqRef.current,
            hasMoreOlder: page.hasMore,
          });
        }
        return fresh.length > 0;
      })
      .catch(() => false)
      .finally(() => {
        loadingOlderRef.current = null;
        setLoadingOlder(false);
      });
    loadingOlderRef.current = inFlight;
    return inFlight;
  }, [selectedId]);
  // Walk the pages back until the session's first message is loaded, then sit at the top.
  //
  // Scrolling up alone can't get there: each page lands with the reader's position anchored
  // (below), which puts them a page BELOW the top again, so the start recedes once per page and a
  // long session's first message is unreachable in practice. This is that loop, made explicit —
  // and bounded, so it can't become an unattended full-history download.
  const jumpToStart = useCallback(async (): Promise<void> => {
    if (jumpingToStartRef.current) return;
    const session = selectedIdRef.current;
    jumpingToStartRef.current = true;
    // Leaving the tail is the whole point, so say so before the first page lands: a transcript
    // still counting itself pinned re-scrolls to the bottom on every content change, which would
    // undo each page of this walk as it arrives.
    atBottomRef.current = false;
    setAtBottom(false);
    try {
      for (let page = 0; page < JUMP_TO_START_PAGES && hasMoreOlderRef.current; page++) {
        if (!(await loadOlder())) break; // that was the end of it (or the session was switched)
      }
    } finally {
      jumpingToStartRef.current = false;
    }
    // Each page the walk pulled in lands pinned to the top (the anchor branch below); this catches
    // the case where the walk ended without one — nothing more to load, or the cap was hit. Not
    // when the reader has moved on to another session, whose transcript this is now.
    if (selectedIdRef.current === session) scrollRef.current?.scrollTo({ top: 0 });
  }, [loadOlder]);
  // loadOlder's mirror, for a window opened at a record: pull in the page just newer than what is
  // loaded as the reader nears the bottom. Rows appended below the viewport move nothing the reader is
  // looking at, so there is no position to hold. The page that reaches the latest event re-attaches
  // the window to the tail, and the live stream opens from there (joinLiveRef).
  const loadNewer = useCallback((): Promise<boolean> => {
    if (loadingNewerRef.current) return loadingNewerRef.current;
    const after = newerCursorRef.current;
    if (!selectedId || after === null) return Promise.resolve(false);
    setLoadingNewer(true);
    const inFlight = getSessionEventPageAfter(selectedId, after, { limit: OLDER_PAGE })
      .then((page) => {
        // Another session, or the window re-opened at another record meanwhile: not this window's page.
        if (selectedIdRef.current !== selectedId || newerCursorRef.current !== after) return false;
        const fresh = page.events.filter((e) => !seen.current.has(e.seq));
        for (const e of fresh) if (typeof e.seq === 'number') seen.current.add(e.seq);
        if (fresh.length) {
          accRef.current = [...accRef.current, ...fresh];
          setEvents(accRef.current);
        }
        newerCursorRef.current = page.after;
        if (page.after === null) {
          setDetached(false);
          joinLiveRef.current?.();
        }
        return fresh.length > 0;
      })
      .catch(() => false)
      .finally(() => {
        loadingNewerRef.current = null;
        setLoadingNewer(false);
      });
    loadingNewerRef.current = inFlight;
    return inFlight;
  }, [selectedId]);
  // The tail-first window's edges, read through callbacks because they live in refs (kept out of
  // render for cost). ⌘F needs both: whether older events exist, and how far back it has loaded.
  const hasOlderNow = useCallback(() => hasMoreOlderRef.current, []);
  const oldestSeqNow = useCallback(() => oldestSeqRef.current, []);
  // Pull back the untrimmed payload of an event the server clipped to a preview (see
  // MAX_EVENT_PAYLOAD). The transcript calls this when the user expands such a card, so a big
  // Read output or Write body only crosses the network if someone actually opens it — and, because
  // a remounted row is a new card with no memory of the first ask, only once (see
  // lib/eventFull.ts). Rebuilt per session: seqs are per session, so a memo outliving the switch
  // would answer this session's 99323 with the last session's.
  const fetchEventFull = useMemo(
    () => memoizeEventFull((seq: number) => getSessionEventFull(selectedId ?? '', seq)),
    [selectedId],
  );
  // Recompute, on scroll and after content changes: are we at the bottom, and which top-level
  // user bubble (if any) has scrolled above the viewport top (= the prompt to surface)?
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setStuck(null);
      return;
    }
    const top = el.scrollTop;
    // Pin to the bottom while at (or near) it; un-pin only when the READER scrolls up. Both the
    // reasoning behind that and the clients' copy of the rule live in tailPinning.ts.
    const sample = sampleTail(el);
    atBottomRef.current = !reviewPositionHeldRef.current && pinnedToTail(
      atBottomRef.current,
      lastSampleRef.current,
      sample,
      performance.now() - readerInputAtRef.current < READER_INPUT_GRACE_MS,
    );
    lastSampleRef.current = sample;
    // A window opened at a record is never at the live tail, whatever its scroll says: its bottom is a
    // gap, so nothing may pin there — and near it the next newer page comes in.
    if (newerCursorRef.current !== null) {
      atBottomRef.current = false;
      if (el.scrollHeight - top - el.clientHeight < LOAD_OLDER_AT) loadNewer();
    }
    // Whether the tail is out of view, whatever put it there, with the pin's own slack — so the
    // button and the follow agree on where the end is. Only a pinned transcript is decided here (one
    // the reader scrolled up shows the button already); the tail back in view ends it at once.
    if (!atBottomRef.current || sample.bottomGap <= NEAR_BOTTOM) {
      window.clearTimeout(strandTimerRef.current);
      strandTimerRef.current = undefined;
      setStranded(false);
    } else if (strandTimerRef.current === undefined) {
      strandTimerRef.current = window.setTimeout(() => setStranded(true), STRANDED_AFTER_MS);
    }
    setAtBottom(atBottomRef.current); // React bails out when unchanged, so no per-scroll re-render
    setHasMoreOlder(hasMoreOlderRef.current); // same bail-out; drives the way back to the start
    // Near the top with older history still on the server → pull in the next page.
    if (top < LOAD_OLDER_AT) loadOlder();
    const topY = el.getBoundingClientRect().top;
    setOpenItemsAbove(
      Array.from(el.querySelectorAll<HTMLElement>('[data-open-item]'))
        .filter((card) => card.getBoundingClientRect().bottom <= topY + 1)
        .map((card) => card.getAttribute('data-open-item'))
        .join(' '),
    );
    // A turn a watch or the control plane queued is one of these too — it is where the answer under
    // it starts, so it is where the bar has to point — but it is no bubble and nobody typed it, so
    // its card hands over what to call it (`data-sticky-label` / `data-sticky-text`). Its queued
    // twin in the tail is skipped like any queued turn: it hasn't been asked yet. A background
    // job's news or a wakeup coming due is not one: it is a line inside the answer the agent is
    // still giving (BackgroundWakeCard), so it carries no label and the bar keeps the question.
    const bubbles = Array.from(
      el.querySelectorAll<HTMLElement>('.chat-user:not(.chat-queued), [data-sticky-label]:not(.is-queued)'),
    ).filter((b) => !b.closest('.chat-subagent')); // ignore prompts nested in a sub-workspace transcript
    let cur: HTMLElement | null = null;
    for (const b of bubbles) {
      if (b.getBoundingClientRect().bottom <= topY + 1) cur = b;
      else break;
    }
    if (cur) {
      const label = cur.getAttribute('data-sticky-label');
      // Only the bubble's rendered markdown — the bubble also holds attachment thumbnails whose
      // hover mask ("Preview") and file chips are in the DOM regardless of visibility, and a raw
      // textContent would splice those labels in front of the question.
      setStuck({
        seq: cur.getAttribute('data-seq'),
        label: label ?? STICKY_LABEL,
        text: label === null
          ? cur.querySelector('.md')?.textContent || ''
          : cur.getAttribute('data-sticky-text') || '',
      });
    } else if (hasMoreOlderRef.current) {
      // No loaded user prompt sits above the viewport, but older pages remain: the prompt for
      // the content now in view is in an unloaded page. Don't blank the bar — show a loading
      // state and pull the earlier page in (no-op if one is already in flight), so measure
      // re-runs after the prepend and resolves the real question.
      setStuck({ seq: null, label: STICKY_LABEL, text: '', loading: true });
      loadOlder();
    } else {
      setStuck(null);
    }
  }, [loadOlder, loadNewer]);
  // The same button in a window opened at a record: the latest message is past the gap, so the window
  // is traded for the tail (backToLatestRef), and the record leaves the URL — a reload now opens at the
  // latest message, which is where the reader went.
  const backToLatest = useCallback(() => {
    reviewPositionHeldRef.current = false;
    atBottomRef.current = true;
    setAtBottom(true);
    backToLatestRef.current?.();
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(RECORD_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  // Snap back to the live tail; the scroll events it fires re-pin atBottomRef via measure().
  const scrollToBottom = useCallback(() => {
    reviewPositionHeldRef.current = false;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);
  // Called on send: re-pin to the live tail so a message fired while scrolled up snaps back to the
  // bottom (and stays pinned as the reply streams) instead of stranding the user in history. The
  // scroll goes to the current tail now for instant feedback; setting atBottomRef ensures the
  // content-change effect below re-pins once the new bubble lands. macOS/iOS parity: ConsoleModel's
  // localSendTick forces the same scroll on send.
  const pinToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [scrollToBottom]);
  // Width of the left session column; drag the divider to resize, persisted to
  // localStorage so the choice survives a reload.
  const [colWidth, setColWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SESSION_COL_KEY));
    return saved >= SESSION_COL_MIN && saved <= SESSION_COL_MAX ? saved : SESSION_COL_DEFAULT;
  });
  const [resizing, setResizing] = useState(false);

  // The list is scoped by `view`. Keep Completed loaded while one of its transcripts is
  // open; every other open session resolves from Open, where live sessions live.
  const effectiveView = projectView ?? (selectedId ? (view === 'completed' ? 'completed' : 'open') : view);
  // The workspace whose conversation list this column is. The route names it on /workspaces/<id>;
  // a /sessions/<id> deep link doesn't, so it's latched from the open session once that
  // resolves (see the effect below) — the query itself is scoped by it, so it can't be
  // derived further down where the list it would depend on is built.
  const [scopeWorkspaceId, setScopeWorkspaceId] = useState<string | null>(lockedWorkspaceId ?? null);
  // How much of the list is loaded. One page on open; scrolling toward the end widens the
  // window (see loadMoreSessions), which re-keys the query to the larger page.
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  // The owner's folders, and this workspace's (docs/session-folders-move-design.md §3, §7).
  const foldersQ = useQuery(sessionFoldersQuery());
  const workspaceFolders = useMemo(
    () => (foldersQ.data ?? []).filter((f) => f.workspaceId === scopeWorkspaceId),
    [foldersQ.data, scopeWorkspaceId],
  );
  // Folders split the list on the client, as on iOS, so a workspace that has any loads its whole
  // list for the view rather than one page: a folder's count, its marks and its page all need every
  // session filed in it. That is the request every native client makes for every list; a workspace
  // without folders keeps paging as before.
  const listByTag = !!tagFilter || groupByTag;
  const foldersShown = listShowsFolders(effectiveView, listByTag) && workspaceFolders.length > 0;
  const projectScope = `${runner.id}:${scopeWorkspaceId}:${effectiveView}:${tagFilter ?? ''}`;
  const [membershipScope, setMembershipScope] = useState<string | null>(null);
  const projectsQ = useQuery({
    ...openProjectsQuery(),
    enabled: !!openProjectId || membershipScope === projectScope,
  });
  const projectsShown = listShowsProjects(effectiveView, listByTag) &&
    ((projectsQ.data?.length ?? 0) > 0 || membershipScope === projectScope);
  // One factory call drives both the list query and the optimistic-update key below, so
  // they can never drift apart; it's also the exact key the BootGate splash pre-warms.
  const sessionsOpts = sessionsQuery({
    runnerId: runner.id,
    workspaceId: scopeWorkspaceId,
    view: effectiveView,
    tagId: tagFilter,
    limit: scopeWorkspaceId && (foldersShown || projectsShown) ? null : sessionLimit,
  });
  const sessionsKey = sessionsOpts.queryKey;
  // While the control-plane stream is connected it pushes list changes (a coalesced refetch per
  // event), so stop the 4s poll; on any stream gap `controlLive` flips false and it resumes.
  const controlLive = useControlPlaneLive();
  const sessionsQ = useQuery({
    ...sessionsOpts,
    enabled: !openProjectId,
    refetchInterval: controlLive || openProjectId ? false : 4000,
    // Widening the window re-keys the query, so hold the rows already on screen while the
    // larger page loads instead of blanking the list. Only within one scope (every key part
    // but the page size): another scope's rows must never stand in for this one's, even for
    // a frame.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey;
      if (!k || sessionsKey.slice(0, -1).some((part, i) => k[i] !== part)) return undefined;
      return prev;
    },
  });
  useEffect(() => {
    if (sessionsQ.data?.some((s) => s.projectMembership)) setMembershipScope(projectScope);
  }, [sessionsQ.data, projectScope]);
  // Capabilities include heartbeat-derived runner availability. Refresh both list and detail when
  // this runner crosses online/offline so a cached RUNNER_OFFLINE denial cannot outlive recovery.
  const previousRunnerAvailability = useRef({ id: runner.id, online: runner.online });
  useEffect(() => {
    const previous = previousRunnerAvailability.current;
    previousRunnerAvailability.current = { id: runner.id, online: runner.online };
    if (previous.id !== runner.id || previous.online === runner.online) return;
    qc.invalidateQueries({ queryKey: ['sessions'] });
    if (selectedId) qc.invalidateQueries({ queryKey: ['session', selectedId] });
  }, [runner.id, runner.online, selectedId, qc]);
  // A row saying "Under review" stops saying it when the review's window runs out, which nothing on
  // the server announces (contract §5 N5): the window is read, never swept. So the list reads again a
  // second after the earliest such row is due, rather than at the next event that happens by.
  const reviewDueAt = (sessionsQ.data ?? []).reduce<number | null>((earliest, row: any) => {
    const due = Date.parse(row?.confirmationUnderReview?.dueAt ?? '');
    return Number.isNaN(due) || (earliest !== null && earliest <= due) ? earliest : due;
  }, null);
  useEffect(() => {
    if (reviewDueAt === null) return;
    const wait = reviewDueAt + 1_000 - Date.now();
    if (wait > 2 ** 31 - 1) return;
    const timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ['sessions'] }), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [qc, reviewDueAt]);
  // The owner's tag library, for the filter menu and the "Group by Tag" headings.
  const sessionTags = useQuery(sessionTagsQuery()).data ?? [];

  const sessions = useMemo(() => {
    const rows = (sessionsQ.data ?? []).slice();
    // The Completed view is ordered by the server on completed_at (newest first) and
    // intentionally ignores pinning. The optimistic cache edits
    // (drop/rename/pin) only remove or patch rows in place — never reorder — and a real
    // Complete reconciles via refetch, so the server order holds. Trust it verbatim.
    if (effectiveView === 'completed') return rows;
    return rows.sort((a, b) => {
      // Pinned sessions float to the top; among themselves they keep time order.
      if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
      const ta = a.lastTurnAt ?? a.createdAt;
      const tb = b.lastTurnAt ?? b.createdAt;
      return ta < tb ? 1 : -1;
    });
  }, [sessionsQ.data, effectiveView]);
  const selectedFromList = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  // Close the header-title editor whenever the open session changes — a stale draft must
  // never commit onto a different session.
  useEffect(() => setEditingTitle(false), [selectedId]);
  // Detail of the open session, keyed the same as TasksSidePanel so React Query dedupes
  // the fetch. Its only job here is to resolve the session's workspace the instant it's opened:
  // a freshly created session isn't in the list query yet (so `selected` is null), but its
  // detail is primed synchronously in send.onSuccess, so this keeps `scopeWorkspaceId` stable
  // across the /workspaces/<id>/new → /sessions/<id> navigation. Without it the list briefly
  // un-scopes (shows every workspace's sessions) until the list refetch lands.
  const sessionDetailQ = useQuery({
    ...sessionQuery(selectedId),
    placeholderData: keepPreviousData,
    // Poll the detail when either side has a live update the runner pushes via heartbeat:
    // while the session is live, for the worktree status bar (isolation + uncommitted diff,
    // reported mid-turn) to appear without waiting for turn_end; and while a "merge to main"
    // or "commit" is pending, for the runner's outcome (≤1 heartbeat away) to land. Idle else.
    refetchInterval: (q) => {
      const detail = q.state.data;
      if (
        detail?.id === selectedId &&
        (detail.mergeStatus === 'pending' || detail.commitStatus === 'pending')
      )
        return 3000;
      const repairState = detail?.mergeRepairSession?.runState
        ?? detail?.mergeRepairSession?.runStatus
        ?? detail?.mergeRepairSession?.status;
      if (['PENDING', 'QUEUED', 'RUNNING'].includes(String(repairState).toUpperCase())) return 3000;
      // A deep-linked/Completed ENDING row may already be absent from the Open list. Keep polling
      // its own current detail until terminal instead of relying solely on selectedFromList.
      return shouldPollSessionDetail(selectedId, detail, selectedFromList) ? 5000 : false;
    },
  });
  const detailForSelected = sessionDetailQ.data?.id === selectedId ? sessionDetailQ.data : null;
  const selectedFromDetail = useMemo(() => {
    const d = detailForSelected as any;
    // A freshly-created session primes only id/runner/workspace into this cache; keep the
    // existing "Starting..." placeholder until the real detail/list row supplies title/status.
    if (
      !d ||
      typeof d.title !== 'string' ||
      (typeof d.runState !== 'string' &&
        typeof d.sessionState !== 'string' &&
        typeof d.runStatus !== 'string' &&
        typeof d.status !== 'string')
    )
      return null;
    return {
      ...d,
      runningBgCount: Array.isArray(d.runningBgShells) ? d.runningBgShells.length : (d.runningBgCount ?? 0),
      // The detail payload carries the ids; the list carries the count. Same normalization for
      // both, so the glyph's motion cannot disagree with the tray's list of processes.
      runningBgJobCount: Array.isArray(d.runningBgJobs)
        ? d.runningBgJobs.length
        : (d.runningBgJobCount ?? 0),
      runningSubagentCount: Array.isArray(d.runningSubagents)
        ? d.runningSubagents.length
        : (d.runningSubagentCount ?? 0),
      pendingApprovals: d.pendingApprovals ?? 0,
    };
  }, [detailForSelected]);
  const selected = selectedFromList ?? selectedFromDetail;
  const selectedMissing = !!selectedId && !selected && sessionDetailQ.isError;
  // Detail is fresher and carries capabilities that compact list rows may omit. Merge nested
  // capabilities field-by-field so a partial rolling-upgrade payload cannot erase a list value.
  const selectedSession = selected
    ? {
        ...selected,
        ...(detailForSelected ?? {}),
        capabilities:
          selected.capabilities || detailForSelected?.capabilities
            ? { ...selected.capabilities, ...detailForSelected?.capabilities }
            : undefined,
      }
    : null;
  // What this conversation is waiting on, when a watch is what will bring it back: the same read the
  // Watching strip above the composer makes (one cache entry between them), so the header's word and
  // the strip under it cannot disagree about the same wait.
  const watchesForHeaderQ = useQuery(watchesQuery());
  const selectedWatchingWord = useMemo(
    () =>
      selectedId && Array.isArray(watchesForHeaderQ.data)
        ? watchingWord(watchesForHeaderQ.data as WatchView[], selectedId)
        : null,
    [watchesForHeaderQ.data, selectedId],
  );
  // The same read for every row of the list: what each session a watch will resume says about the
  // wait, so a row, the header and the strip cannot disagree about it either.
  const watchingBySession = useMemo(
    () => watchingSessions(Array.isArray(watchesForHeaderQ.data) ? (watchesForHeaderQ.data as WatchView[]) : []),
    [watchesForHeaderQ.data],
  );
  // The project this conversation coordinates, if any — see projectBackLink. Read the merged row
  // so a fresh detail can enrich (or correct) the compact list snapshot during rolling upgrades.
  const projectBack = projectBackLink(selectedSession);
  const selectedLifecycleState = selectedSession
    ? sessionLifecycleStateOf(
        selectedSession,
        { listView: selectedFromList ? effectiveView : undefined },
      )
    : null;
  const selectedTrashed = selectedLifecycleState === 'TRASH';
  const selectedCompleted = selectedLifecycleState === 'COMPLETED';
  // Whether a public link opens this conversation right now: the detail's open link once it has
  // been read, the list row's flag until then. The Trash pauses a link, so a trashed one is not.
  const selectedShared =
    !selectedTrashed &&
    (detailForSelected ? detailForSelected.shareToken != null : (selected as any)?.shared === true);
  // Keep an observer on every locally accepted Merge/Commit until its runner reports a terminal
  // result. Unlike the selected-detail-only observer this survives switching conversations, and
  // the operation token prevents a stale query result from finishing a newer retry for the same
  // session. Pre-existing terminal statuses never toast: entries are added only after a click is
  // accepted by the API in the mutations below.
  const pendingOperations = useMemo(
    () => Object.values(pendingSessionOperations),
    [pendingSessionOperations],
  );
  const pendingOperationQueries = useQueries({
    queries: pendingOperations.map((operation) => ({
      ...sessionQuery(operation.id),
      refetchInterval: 3000,
    })),
  });
  const notifiedOperationTokens = useRef(new Set<number>());
  useEffect(() => {
    const finished: PendingSessionOperation[] = [];
    pendingOperations.forEach((operation, index) => {
      const query = pendingOperationQueries[index];
      // A deleted session has no result left to report. Likewise, a successful detail response
      // whose operation status was cleared means another action (for example Resume) superseded
      // the request. Stop observing both cases instead of polling an orphan forever; transient
      // fetch failures remain tracked and retry normally.
      if (query?.isError && query.error instanceof ApiError && query.error.status === 404) {
        finished.push(operation);
        return;
      }
      const d = query?.data;
      if (!d || d.id !== operation.id || notifiedOperationTokens.current.has(operation.token)) return;
      const status = operation.kind === 'merge' ? d.mergeStatus : d.commitStatus;
      if (!status) {
        if (query.isSuccess && query.fetchStatus === 'idle') finished.push(operation);
        return;
      }
      if (status === 'pending') return;

      notifiedOperationTokens.current.add(operation.token);
      finished.push(operation);
      if (operation.kind === 'merge') {
        const target = d.mergeTarget || operation.target || 'main';
        if (status === 'merged') {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: d.mergeRecovery?.code === 'LOCAL_SYNC_PENDING' ? `Merged into origin/${target}; local sync pending` : `Merged into ${target}`,
            detail: d.mergeRecovery?.code === 'LOCAL_SYNC_PENDING' ? d.mergeError ?? 'Sync the local checkout from the recovery panel.' : undefined,
            tone: d.mergeRecovery?.code === 'LOCAL_SYNC_PENDING' ? 'warning' : 'success',
            icon: 'check',
          });
        } else if (status === 'conflict') {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: `Couldn't merge into ${target}`,
            detail: d.mergeError ?? 'Merge aborted; your branch is unchanged.',
            tone: 'error',
            action: d.branch ? {
              label: 'Resolve in session',
              ariaLabel: `Resolve the conflict in ${operation.title}`,
              onClick: () => resolveMut.mutate({
                id: operation.id,
                title: operation.title,
                branch: d.branch!,
                target,
              }),
            } : undefined,
          });
        } else {
          message.sessionNotice({
            sessionId: operation.id,
            sessionTitle: operation.title,
            event: 'merge-result',
            headline: `Couldn't merge into ${target}`,
            detail: d.mergeError ?? 'See the status bar for details.',
            tone: 'error',
          });
        }
      } else if (status === 'committed') {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: 'Changes committed',
          detail: runnerCommitLine(d.commitResultMessage),
          tone: 'success',
          icon: 'check',
        });
      } else if (status === 'nochange') {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: 'No changes to commit',
          detail: runnerCommitLine(d.commitResultMessage),
          tone: 'neutral',
          icon: 'info',
        });
      } else {
        message.sessionNotice({
          sessionId: operation.id,
          sessionTitle: operation.title,
          event: 'commit-result',
          headline: "Couldn't commit",
          // The runner's plain sentence when it gave one; git's words otherwise (commitFailureCopy).
          detail: commitFailureCopy(d.commitError, d.commitResultMessage).why,
          tone: 'error',
        });
      }
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    });

    if (finished.length === 0) return;
    setPendingSessionOperations((current) => {
      const next = { ...current };
      finished.forEach((operation) => {
        if (next[operation.id]?.token === operation.token) delete next[operation.id];
      });
      return next;
    });
  }, [message, pendingOperationQueries, pendingOperations, qc]);
  const live = !!selectedSession && !selectedTrashed && isSessionLive(selectedSession);
  // On older servers, infer resumability exactly as before. Newer servers know whether runner
  // context still exists and are authoritative — notably preventing a false-positive Resume.
  const legacyResumable =
    !!selectedSession &&
    !selectedTrashed &&
    !live &&
    !!selectedSession.startedAt &&
    !!runner.online;
  const resumable = selectedSession
    ? sessionCapabilityOf(selectedSession, 'canResume', legacyResumable)
    : false;
  const selectedResumeBlockedReason = selectedSession
    ? sessionResumeBlockedReasonOf(selectedSession)
    : null;
  const selectedResumeBlockedCopy = sessionResumeBlockedMessage(selectedResumeBlockedReason);
  // A run can still look live/resumable in cached state while a Complete/end transition has
  // already denied its same-session endpoint. Never reinterpret that denial as a fresh run.
  const sameSessionSendBlocked =
    !!selectedSession &&
    (live || resumable) &&
    !sessionCapabilityOf(selectedSession, 'canSend', true);
  const sameSessionSendBlockedCopy = sessionSendBlockedMessage(selectedResumeBlockedReason);
  const selectedCanComplete = selectedSession
    ? sessionCapabilityOf(selectedSession, 'canComplete', selectedLifecycleState === 'OPEN')
    : false;
  const selectedCanRestore = selectedSession
    ? sessionCapabilityOf(
        selectedSession,
        'canRestore',
        selectedLifecycleState === 'COMPLETED' || selectedLifecycleState === 'TRASH',
      )
    : false;
  // The session list (always visible in the left column) is scoped to one workspace so
  // it reads as a conversation with that workspace. On /workspaces/<id> that's the locked
  // workspace; on a /sessions/<id> deep link the URL carries no workspace, so fall back to
  // the selected session's own workspace. Feeds the query above (hence the state), which is
  // why the client-side filter below stays: it covers the frame before the re-scoped
  // list lands, and the case where no workspace resolves at all.
  const resolvedWorkspaceId =
    lockedWorkspaceId ?? selected?.workspace?.id ?? detailForSelected?.workspace?.id ?? null;
  useEffect(() => setScopeWorkspaceId(resolvedWorkspaceId), [resolvedWorkspaceId]);
  const visibleSessions = useMemo(() => {
    let list = resolvedWorkspaceId ? sessions.filter((s) => s.workspace?.id === resolvedWorkspaceId) : sessions;
    // The tag filter is the query's too; re-applying it here keeps arrow-nav, auto-select and
    // "open the next session after completing" stepping through exactly what's on screen even
    // in the frame before a just-changed filter's rows land.
    if (tagFilter) list = sessionsWithTag(list, tagFilter);
    return list;
  }, [sessions, resolvedWorkspaceId, tagFilter]);
  // Other workspaces may contain only workers. Read the project's words across workspaces,
  // keeping this view's activity and folder count scoped to its own members.
  const projectData = useSessionProjectData({
    sessions: visibleSessions, view: effectiveView, enabled: projectsShown && !openProjectId,
    controlLive, needsYou: (s) => sessionLine(s, true, sessionWatching(watchingBySession, s.id)).tone === 'approval',
  });
  const projectSessionsQ = useQuery({
    ...projectSessionsQuery({ projectId: openProjectId ?? '', view: 'open' }),
    enabled: !!openProjectId,
    refetchInterval: controlLive ? PROJECT_SESSION_REFRESH_MS : 4000,
  });
  const completedProjectSessionsQ = useQuery({
    ...projectSessionsQuery({ projectId: openProjectId ?? '', view: 'completed' }),
    enabled: !!openProjectId,
    refetchInterval: controlLive ? PROJECT_SESSION_REFRESH_MS : 4000,
  });
  const projectMembers = useMemo(() => [...new Map(
    [...(projectSessionsQ.data ?? []), ...(completedProjectSessionsQ.data ?? [])].map((s) => [s.id, s]),
  ).values()].sort((a, b) => (Date.parse(b.lastTurnAt ?? b.createdAt ?? '') || 0) -
    (Date.parse(a.lastTurnAt ?? a.createdAt ?? '') || 0)), [projectSessionsQ.data, completedProjectSessionsQ.data]);
  const pageCoordinator = projectMembers.find((s) => s.projectMembership?.role === 'COORDINATOR') ?? null;
  const pageMenuCoordinator = pageCoordinator;
  const pageProject = projectsQ.data?.find((p) => p.id === openProjectId);
  const pageProjectDetailsQ = useQuery({
    ...projectDetailsQuery(openProjectId ?? ''),
    enabled: !!openProjectId && projectsQ.isSuccess && !pageProject,
    refetchInterval: PROJECT_SESSION_REFRESH_MS,
  });
  const pageTasksByStatus = pageProjectDetailsQ.data?.tasksByStatus;
  const pageTaskCounts = pageProject?.taskCounts ?? (pageTasksByStatus ? {
    done: pageTasksByStatus.DONE ?? 0,
    failed: pageTasksByStatus.FAILED ?? 0,
    total: Object.entries(pageTasksByStatus).reduce((total, [status, count]) => status === 'CANCELLED' ? total : total + count, 0),
  } : undefined);
  const pageProjectTitle = pageProject?.title ?? pageProjectDetailsQ.data?.title ?? projectMembers[0]?.projectMembership?.projectTitle ?? pageMenuCoordinator?.projectMembership?.projectTitle ?? 'Project';
  const pageRunningCount = projectMembers.filter((s) => statusGlyphMotion(s) === 'spinner').length;
  // The folder page the list is on: `?folder=<id>` on whichever route the console is at, so it
  // survives a reload and Back leaves it. Only a folder of this workspace, and only where the list
  // shows folders at all.
  const folderParam = searchParams.get('folder');
  const openFolder = useMemo(() => {
    const id = routeId(folderParam);
    return !openProjectId && foldersShown && id ? (workspaceFolders.find((f) => f.id === id) ?? null) : null;
  }, [folderParam, foldersShown, workspaceFolders, openProjectId]);
  // A folder page whose folder is gone — deleted here or on another client, or a link into another
  // workspace's — goes back to the list. Only once both the folders and the list's workspace are
  // known: before that a missing folder is one not loaded yet.
  useEffect(() => {
    if (openProjectId || !folderParam || openFolder || !foldersQ.isSuccess || !scopeWorkspaceId) return;
    if (!listShowsFolders(effectiveView, listByTag)) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('folder');
        return next;
      },
      { replace: true },
    );
  }, [folderParam, openFolder, foldersQ.isSuccess, scopeWorkspaceId, effectiveView, listByTag, setSearchParams, openProjectId]);
  // The list split into its folder rows and the sessions in no folder — the ones the Pinned and
  // time sections below are made of. A folder's page lists the sessions filed in it instead.
  const folderListing = useMemo(
    () => sessionProjectListing(visibleSessions, workspaceFolders, projectsQ.data ?? [], {
      view: effectiveView,
      byTag: listByTag,
      folderId: openFolder?.id,
      coordinators: projectData.coordinators,
      contentSessions: projectData.contentSessions,
      runnerOffline: runner.online === false,
      needsYou: sessionNeedsYou,
      motion: (s) => statusGlyphMotion(s, sessionWatching(watchingBySession, s.id)?.word),
      line: (s) => sessionLine(selectedSession?.id === s.id ? selectedSession : s,
        effectiveView !== 'trash', sessionWatching(watchingBySession, s.id)),
    }),
    [openFolder, visibleSessions, workspaceFolders, projectsQ.data, projectData.coordinators, projectData.contentSessions,
      effectiveView, listByTag, runner.online, watchingBySession, selectedSession],
  );
  const listedSessions = useMemo(
    () => openProjectId ? projectMembers : folderListing.entries.flatMap((entry) => entry.kind === 'project'
      ? entry.coordinator ? [entry.coordinator] : [] : [entry]),
    [folderListing, openProjectId, projectMembers],
  );
  // Where a session opened from this list lives. On a folder's page the page goes along, so the
  // list stays on it while the conversations it lists are opened one after another.
  const folderSearch = openFolder ? `?folder=${encodeId(openFolder.id)}` : '';
  const listSearch = openProjectId
    ? `?project=${encodeId(openProjectId)}${effectiveView === 'completed' ? '&view=completed' : ''}${folderParam ? `&folder=${encodeURIComponent(folderParam)}` : ''}` : folderSearch;
  const sessionPath = useCallback((id: string) => `/sessions/${encodeId(id)}${listSearch}`, [listSearch]);

  // Paging. The server answered with a full page, so there is probably more behind it; a short
  // answer means this scope is exhausted.
  const hasMoreSessions = !openProjectId && !foldersShown && !projectsShown && (sessionsQ.data?.length ?? 0) >= sessionLimit;
  // The column has nothing to show yet for this scope (a switch to a workspace not in cache), or
  // is widening its window — `isPlaceholderData` is exactly that, since the guard above only
  // keeps rows within one scope. Neither is the ordinary background refresh, which must not
  // flash anything over rows that are already correct.
  const loadingSessions = openProjectId ? projectSessionsQ.isPending || completedProjectSessionsQ.isPending : sessionsQ.isPending || sessionsQ.isPlaceholderData;
  const loadMoreSessions = useCallback(() => {
    if (!hasMoreSessions || sessionsQ.isFetching) return;
    setSessionLimit((n) => n + SESSION_PAGE_SIZE);
  }, [hasMoreSessions, sessionsQ.isFetching]);
  // A new scope starts at one page again: a window grown by scrolling deep into one workspace's
  // history must not make the next workspace (or view, or tag) fetch just as deep.
  useEffect(() => {
    setSessionLimit(SESSION_PAGE_SIZE);
  }, [runner.id, scopeWorkspaceId, effectiveView, tagFilter]);
  // The server pages what the column shows, but a frame where the client narrows further (an
  // workspace that hasn't resolved into the query yet) can hold too few visible rows to be
  // scrollable — and without a scroll there is nothing to trigger the next page. Top it up here.
  useEffect(() => {
    if (visibleSessions.length >= SESSION_PAGE_SIZE) return;
    loadMoreSessions();
  }, [visibleSessions.length, loadMoreSessions]);
  // Widen the window as the list nears its end, so scrolling reads as one continuous list.
  const onSessionListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight > SESSION_LOAD_MORE_PX) return;
      loadMoreSessions();
    },
    [loadMoreSessions],
  );

  // The list's sections. Recency by default (Pinned / Today / Yesterday / …), or one section per
  // tag when the user switches grouping — both from the pure groupers shared in shape with
  // OrbitKit's, over the already console-sorted list. Pinning only applies in Open, and
  // a "Pinned" section would fight an active tag filter, so it's suppressed there (as on iOS).
  // Note the Completed view is server-ordered by completed_at while bucketing reads last activity,
  // so its rows are grouped by when they last ran, not by when they moved — same as iOS.
  const sections = useMemo<Array<{ key: string; title: string; tag: SessionTagRef | null; sessions: SessionProjectEntry<SessionListItem>[] }>>(
    () =>
      openProjectId
        ? [
            ...(pageCoordinator ? [{ key: 'Coordinator', title: SESSION_PROJECT_COPY.coordinatorSection, tag: null,
              sessions: [{ ...pageCoordinator, kind: 'session' as const }] }] : []),
            ...sessionTimeSections(projectMembers.filter((s) => s.id !== pageCoordinator?.id), { pinnedFirst: false })
              .map((s) => ({ ...s, key: s.title, tag: null, sessions: s.sessions.map((row) => ({ ...row, kind: 'session' as const })) })),
          ]
        : groupByTag
        ? sessionTagSections(folderListing.entries).map((s) => ({
            key: s.tag?.id ?? '__untagged__',
            tag: s.tag,
            title: s.tag?.name ?? 'Untagged',
            sessions: s.sessions,
          }))
        : sessionTimeSections(folderListing.entries, {
            pinnedFirst: view === 'open' && !tagFilter,
          }).map((s) => ({
            key: s.title,
            tag: null as SessionTagRef | null,
            ...s,
            // Folded, Pinned keeps its heading but none of its rows — on screen or in the order below.
            sessions: s.title === 'Pinned' && pinnedCollapsed ? [] : s.sessions,
          })),
    [folderListing, groupByTag, view, tagFilter, pinnedCollapsed, openProjectId, pageCoordinator, projectMembers],
  );

  // The rows in the order they're actually on screen. Sectioning can reorder relative to the
  // server sort — Completed arrives ordered by completion time but buckets by last activity,
  // and tag grouping regroups outright — so anything that moves the cursor by a row (Up/Down,
  // "open the next one after completing") has to walk this, not the pre-section list.
  const orderedSessions = useMemo(() => sections.flatMap((s) => s.sessions.flatMap((entry) =>
    entry.kind === 'project' ? entry.coordinator ? [entry.coordinator] : [] : [entry],
  )), [sections]);

  // Right-pane mode. A real session (/sessions/<id>) shows its conversation; with
  // none selected we're composing a new session — explicitly (/workspaces/<id>/new),
  // while browsing Completed/Trash (nothing openable there), or implicitly
  // when the Open list is empty (the first-run empty state).
  const composing =
    !selectedId &&
    (composingRoute || view !== 'open' || (sessionsQ.isSuccess && listedSessions.length === 0));
  // The Projects CTA lands on the ordinary New Session route with one piece of transient framing:
  // this turn is meant to create a project. Keeping it in the URL makes refresh/back truthful and
  // lets dismissing it return to the byte-for-byte ordinary compose without a second screen/state.
  const projectIntent = composing && searchParams.get('intent') === 'project';
  const dismissProjectIntent = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('intent');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // Remember the open session as this workspace's last-viewed one, so returning to the workspace
  // (a workspace-switch away and back, or clicking it in the sidebar) restores it below.
  useEffect(() => {
    const workspaceId = selected?.workspace?.id;
    if (selectedId && workspaceId) lastSessionByWorkspace.set(workspaceId, selectedId);
  }, [selectedId, selected?.workspace?.id]);

  // Default landing: opening /workspaces/<id> in Open (no session, not the /new draft)
  // opens a session so the right pane is never blank. Prefer the one the user last had open
  // for this workspace (remembered above) — reopening where they left off — and fall back to the
  // most recent when there's no memory (or it's since been completed/trashed out of view).
  // replace() keeps it out of history; Completed/Trash never auto-open.
  useEffect(() => {
    // On mobile the list is its own full screen — auto-opening would trap the back
    // button (it returns here, which would immediately redirect into a session again).
    if (openProjectId || isMobile || selectedId || composingRoute || view !== 'open' || !sessionsQ.isSuccess)
      return;
    // Not before the folders are known: the session opened is one the list shows, and until then a
    // session filed in a folder could be picked from under it. A server without folders answers
    // with an error, which is known too.
    if (foldersQ.isPending) return;
    const remembered = scopeWorkspaceId ? lastSessionByWorkspace.get(scopeWorkspaceId) : undefined;
    const target = listedSessions.find((s) => s.id === remembered) ?? listedSessions[0];
    if (target) navigate(sessionPath(target.id), { replace: true });
  }, [
    isMobile,
    openProjectId,
    selectedId,
    composingRoute,
    view,
    sessionsQ.isSuccess,
    foldersQ.isPending,
    listedSessions,
    scopeWorkspaceId,
    navigate,
    sessionPath,
  ]);

  // Step the open session up/down the visible list, for the window-level Up/Down handler
  // below. Returns false (a no-op) at the list ends, on an empty list, or on the trash
  // view with nothing open. With nothing selected, Down enters from the top, Up from
  // the bottom.
  const stepSession = useCallback(
    (dir: 1 | -1): boolean => {
      if (!selectedId && view === 'trash') return false;
      if (orderedSessions.length === 0) return false;
      const cur = orderedSessions.findIndex((s) => s.id === selectedId);
      let next: number;
      if (cur === -1) next = dir === 1 ? 0 : orderedSessions.length - 1;
      else {
        next = cur + dir;
        if (next < 0 || next >= orderedSessions.length) return false; // stop at the ends
      }
      navigate(sessionPath(orderedSessions[next].id));
      return true;
    },
    [orderedSessions, selectedId, view, navigate, sessionPath],
  );

  // Up/Down arrows step through the session list (left column), switching the open
  // session like tabs. Skipped while typing in an input/textarea (so the composer and
  // Ant dropdowns keep their own arrows).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (menuOpenId || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      )
        return;
      if (stepSession(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpenId, stepSession]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('.session-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Workspaces belonging to this machine runner — each is a project dir + coding tool.
  // Picking one tells the server where (which dir) to run a new session.
  const workspacesQ = useQuery(workspacesQuery());
  const workspacesForRunner = useMemo(
    () => (workspacesQ.data ?? []).filter((a) => a.runnerId === runner.id),
    [workspacesQ.data, runner.id],
  );
  const lockedWorkspace = useMemo(
    () => (lockedWorkspaceId ? (workspacesForRunner.find((a) => a.id === lockedWorkspaceId) ?? null) : null),
    [workspacesForRunner, lockedWorkspaceId],
  );
  // The workspace picked for a NEW session. An existing session keeps its owning workspace separately.
  const pickedWorkspace = useMemo(
    () => workspacesForRunner.find((a) => a.id === workspaceId) ?? null,
    [workspacesForRunner, workspaceId],
  );
  // When scoped to a specific workspace (/workspaces/<id>) lock the pick to it; otherwise
  // default to the runner's first workspace, keeping a valid pick across runner switches.
  useEffect(() => {
    if (lockedWorkspaceId) {
      setWorkspaceId(lockedWorkspaceId);
      return;
    }
    setWorkspaceId((prev) =>
      prev && workspacesForRunner.some((a) => a.id === prev) ? prev : workspacesForRunner[0]?.id,
    );
  }, [workspacesForRunner, lockedWorkspaceId]);

  // The New Session provider pick, scoped to the workspace it was made under: switching workspaces means
  // switching projects, so the previous pick must not follow. Kept as {workspaceId, provider} rather
  // than reset by an effect so the stale value is never readable for a render.
  const [draftProviderPick, setDraftProviderPick] = useState<{
    workspaceId?: string;
    provider: string;
  } | null>(null);
  const draftProvider =
    draftProviderPick && draftProviderPick.workspaceId === workspaceId ? draftProviderPick.provider : null;
  // The provider a NEW session would run: an explicit pick, else what this project last ran on.
  // `lastProvider` is derived server-side from the workspace's most recent interactive session — an
  // workspace holds no provider of its own (apiserver workspaces/workspace-provider.ts). `provider` is the
  // deprecated alias of the same derived value, still served for older native builds.
  const pickedProvider: string =
    draftProvider ?? pickedWorkspace?.lastProvider ?? pickedWorkspace?.provider ?? 'claude';
  // The Codex or Claude account picked for the draft on the New Session hero, scoped to its workspace
  // like the provider pick. Without one a new session starts where Automatic or its workspace says.
  const [draftAccountPick, setDraftAccountPick] = useState<{
    workspaceId?: string;
    engine: string;
    account: string;
  } | null>(null);
  const draftPickHere = draftAccountPick && draftAccountPick.workspaceId === workspaceId ? draftAccountPick : null;
  const draftCodexAccount = draftPickHere?.engine === 'codex' ? draftPickHere.account : null;
  const draftClaudeAccount = draftPickHere?.engine === 'claude' ? draftPickHere.account : null;

  // A provider switch made on an ENDED session, scoped to that session for the same reason the
  // draft pick is scoped to its workspace. There is nothing to PATCH while a session is ended, so
  // this rides along with the resume that revives it — the same route Model/Mode/Effort take.
  const [endedProviderPick, setEndedProviderPick] = useState<{
    sessionId: string;
    provider: string;
    /** The account of the engine `provider` moves it onto, picked under it in the Provider menu. */
    account?: string;
  } | null>(null);
  // Gated on `live` rather than cleared: once the resume lands the session is live and carries
  // the new provider itself, so the pick simply stops applying — and a later switch through the
  // live pill can't be shadowed by this stale one.
  const pendingResumeProvider =
    selected && !live && endedProviderPick?.sessionId === selected.id
      ? endedProviderPick?.provider
      : null;
  const pendingResumeAccount = pendingResumeProvider ? (endedProviderPick?.account ?? null) : null;
  // The provider this composer talks to: a live session's own, an ended session's pending pick,
  // else the one picked for the draft. Declared here (not next to its other consumers) because
  // the `/` autocomplete memo below needs it.
  const shownProvider: string = selected
    ? (pendingResumeProvider ?? selected.provider ?? detailForSelected?.provider ?? 'claude')
    : pickedProvider;
  const shownProviderCapabilitiesResolved = providerIdentityResolved(
    shownProvider,
    configuredProvidersLoaded,
  );
  // Codex has no slash registry: its app-server takes the prompt verbatim (no expansion of
  // `~/.codex/prompts`, nothing in the protocol for it), so `/anything` is plain text there.
  // Claude's commands and skills are meaningless in that session — don't offer them, and
  // don't gate sending on them. `/status` is ours and stays.
  // DeepSeek Harness has no runner slash registry either; its configured slug is read as its runtime.
  const slashProvider =
    runtimeForProvider(shownProvider, configuredProviders) === AgentProvider.DSH ? AgentProvider.DSH : shownProvider;
  const codexComposer = !supportsRunnerSlashAssets(slashProvider);
  // The selected session's permission mode as the SERVER resolves it: its own stored mode, else
  // the owner's account default, else Auto (common/permission-mode.ts). Reading the session row
  // alone would show one fixed mode for every session that never stored one — and since the pills
  // are authoritative on send, resuming one would then WRITE that mode over what the account
  // actually asked for. The mode is deliberately NOT a workspace field: a checkout wants Plan for
  // a risky migration and Auto for a test fix, so the posture belongs to the run.
  const effectivePermissionMode: string =
    selected?.permissionMode ?? accountDefaultPermissionMode ?? 'auto';
  const selectedWorkspaceFromList = workspacesForRunner.find((a) => a.id === selected?.workspace?.id);
  // Which workspace this console is about: the open session's, else the one a new session would use.
  // Its heartbeat-reported checkout drives the "this machine is wedged" notice above the bar.
  const consoleWorkspaceId: string | undefined = selected?.workspace?.id ?? workspaceId;
  const consoleWorkspaceRepoHealth =
    (workspacesForRunner.find((a) => a.id === consoleWorkspaceId)?.repoHealth as
      | { root: string; state: string; paths?: string[]; branch?: string }
      | null
      | undefined) ?? null;
  const effectiveSelectedModel = effectiveSessionModel(
    shownProvider,
    selected?.model,
    detailForSelected?.workspace?.model ?? selected?.workspace?.model ?? selectedWorkspaceFromList?.model,
    runner.modelCatalog,
    configuredProviders,
    runner.runtimeDefaultModels,
  );
  const effectiveSelectedEffort = effectiveSessionEffort(
    selected?.effort,
    detailForSelected?.workspace?.effort ?? selected?.workspace?.effort ?? selectedWorkspaceFromList?.effort,
  );

  // Same fallback chain as the permission mode above: a session that never stored a model of its
  // own runs the owning workspace's model, so the picker must show that — not the provider default.
  // A pin the runtime has retired drops out of the chain (livePinnedModel), so a session left on
  // last generation's model seeds the current default instead of an id that is no longer offered.
  const selectedModelDefault = selected
    ? livePinnedModel(
        selected.model,
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      ) ??
      livePinnedModel(
        detailForSelected?.workspace?.model ??
          workspacesForRunner.find((a) => a.id === selected.workspace?.id)?.model,
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      ) ??
      defaultModelForProvider(
        shownProvider,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      )
    : null;

  // Seed Effort from a non-live (resumable) session's stored config. The live/ended suffix gives
  // an ended session a fresh context after its final turn, while the dirty guard keeps later async
  // data from clobbering an effort explicitly picked for that resume.
  useEffect(() => {
    if (!selected || live) return;
    const contextKey = `session:${selected.id}:ended`;
    const decision = decideContextSeed(effortSeedState.current, contextKey, true);
    effortSeedState.current = decision.state;
    if (!decision.apply) return;
    const provider = selected.provider ?? detailForSelected?.provider ?? 'claude';
    const owningWorkspace = workspacesForRunner.find((a) => a.id === selected.workspace?.id);
    setEffort(
      normalizeEffortForProvider(
        provider,
        selected.effort ?? detailForSelected?.workspace?.effort ?? owningWorkspace?.effort ?? '',
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, live]);

  // The same seeding for Fast mode, without the seed-state ref the three pills above need: the
  // value is on the session row itself, so there is no late-arriving workspace or account default
  // that could come back and overwrite a pick made for this resume.
  useEffect(() => {
    if (!selected || live) return;
    setFastMode(selected.fastMode === true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, live]);

  const pickedModelDefault = pickedWorkspace
    ? newSessionModelForProvider(
        pickedProvider,
        me.data?.preferences?.defaultModels,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
      )
    : null;
  const pickedProviderCapabilitiesResolved = providerIdentityResolved(
    pickedProvider,
    configuredProvidersLoaded,
  );

  // Everything that could run a session on this machine: engines first — with the health this
  // runner reported, since the session runs there — then this account's providers. The New
  // Session hero offers all of it; the composer's Provider pill offers the same-runtime slice.
  const providerWorkspace = selected
    ? (workspacesQ.data ?? []).find((workspace) => workspace.id === selected.workspace?.id)
    : pickedWorkspace;
  const antigravityKeyAvailable = providerWorkspace
    ? providerWorkspace.antigravityKeyAvailableByRunner?.[runner.id] === true
    : runner.antigravity?.envKeyAvailable === true;
  const providerChoicesForRunner = useMemo(
    () =>
      providerChoices(
        configuredProviders,
        runner.modelCatalog,
        runner.runtimeDefaultModels,
        runner.engines,
        accountPools,
        runner.planUsage,
        runner.antigravity,
        antigravityKeyAvailable,
        runner,
      ),
    [
      configuredProviders,
      runner,
      runner.modelCatalog,
      runner.runtimeDefaultModels,
      runner.engines,
      accountPools,
      runner.planUsage,
      runner.antigravity,
      antigravityKeyAvailable,
    ],
  );
  const currentProviderChoiceForDraft = useMemo(
    () =>
      currentProviderChoice(
        pickedProvider,
        providerChoicesForRunner,
        runner.modelCatalog,
        configuredProviders,
        runner.runtimeDefaultModels,
        runner.antigravity,
      ),
    [
      pickedProvider,
      providerChoicesForRunner,
      runner.modelCatalog,
      configuredProviders,
      runner.runtimeDefaultModels,
      runner.antigravity,
    ],
  );
  // What a switch just changed. Shown under the summary and cleared on a timer: the model move
  // is a silent side effect otherwise, and so is the write-back that remembers the pick.
  const [providerSwitchNote, setProviderSwitchNote] = useState<string | null>(null);
  const providerNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (providerNoteTimer.current) clearTimeout(providerNoteTimer.current); }, []);
  // A refusal about who holds this session's task, kept BESIDE the send it refused so that
  // answering it re-sends exactly that message rather than whatever the composer holds by then.
  // Null while nothing is in the way, which is almost always.
  const [runConflict, setRunConflict] = useState<
    { conflict: TaskRunConflict; vars: ComposerSendVars } | null
  >(null);
  // Whether a run of this session's task is going right now — the thing that decides whether a
  // provider pick can land on this turn or only on the next one. A HINT, and deliberately read
  // off rows this view already holds rather than by asking: it changes what the composer SAYS,
  // never what it does. What a pick is allowed to do is the server's answer to the send, which is
  // where a stale read here turns into the confirmation below rather than into a wrong outcome.
  const taskRunIsGoing = useMemo(() => {
    if (live) return true;
    const taskId = selectedSession?.taskId ?? null;
    if (!taskId) return false;
    return sessions.some((s: any) => s.id !== selectedId && s.taskId === taskId && isSessionBusy(s));
  }, [live, selectedSession?.taskId, selectedId, sessions]);
  // What the pick on an ended session will actually do, and when. It replaces a four-second
  // `Model → X`, which named the change but not its timing — and the timing is the question,
  // because a run keeps its provider for its whole life.
  const composerProviderNote = pendingResumeProvider
    ? providerSwitchNoteFor({
        from: selected?.provider ?? detailForSelected?.provider ?? null,
        to: pendingResumeProvider,
        liveRun: taskRunIsGoing,
      })
    : null;
  // Where a routed message landed. Kept as state rather than a toast because it survives the
  // navigation that follows it: the reader arrives in the other run already knowing why.
  const [handedOverTo, setHandedOverTo] = useState<string | null>(null);
  const pickDraftProvider = (slug: string): void => {
    setDraftProviderPick({ workspaceId, provider: slug });
    const picked = providerChoicesForRunner.find((c) => c.slug === slug);
    // The pick binds this session and nothing else. Later sessions follow it only because the
    // default is read back from what this project last ran — no config is being rewritten.
    setProviderSwitchNote(picked ? `Model → ${picked.modelLabel}` : null);
    if (providerNoteTimer.current) clearTimeout(providerNoteTimer.current);
    providerNoteTimer.current = setTimeout(() => setProviderSwitchNote(null), 4000);
  };
  // An account row under an engine: that engine, on that account — or on Automatic (`null`). Like the
  // provider, it binds the session being drafted and rewrites no workspace setting.
  const pickDraftAccount = (slug: string, account: string | null): void => {
    if (slug !== pickedProvider) pickDraftProvider(slug);
    setDraftAccountPick(account === null ? null : { workspaceId, engine: slug, account });
  };

  // The provider is part of the draft's seed context: picking a different one has to re-seed
  // Model (each provider owns its own model space) and re-clamp Mode, which is exactly what a
  // context change does — including resetting `dirty`, so a model chosen for the old provider
  // never carries into the new one's namespace.
  const modelContextKey = selectedId
    ? `session:${selectedId}`
    : `draft:${runner.id}:${workspaceId ?? 'none'}:${pickedProvider}`;
  const effortContextKey = selectedId
    ? `session:${selectedId}:${live ? 'live' : 'ended'}`
    : modelContextKey;
  const modelSeed = selectedId ? (!live ? selectedModelDefault : null) : pickedModelDefault;

  // A late Runtime catalog/configured-provider response may refine the seed for an untouched
  // picker. Once the user chooses any model, ignore seed changes until the Workspace/Session context
  // changes. Dirty is explicit rather than inferred from value equality: choosing the same value
  // is still an intentional choice.
  useEffect(() => {
    const decision = decideContextSeed(modelSeedState.current, modelContextKey, !!modelSeed);
    modelSeedState.current = decision.state;
    if (decision.apply && modelSeed) setModel(modelSeed);
  }, [modelContextKey, modelSeed]);

  // A new session defaults to Auto — the app-level default (DEFAULT_PERMISSION_MODE) — rather
  // than inheriting the picked workspace's stored mode, which still governs task-launched runs
  // server-side. Clamp when the effective provider/model can't run Auto, as elsewhere.
  const pickedModeSeed =
    PERMISSION_TO_MODE[
      pickedProviderCapabilitiesResolved
        ? clampPermissionModeForModel(
            'auto',
            pickedModelDefault ?? DEFAULT_MODEL,
            pickedProvider,
            configuredProviders,
            runner.modelCatalog,
          )
        : 'auto'
    ] ?? 'Default';
  const modeSeed = selectedId
    ? !live && selected
      ? PERMISSION_TO_MODE[
          shownProviderCapabilitiesResolved
            ? clampPermissionModeForModel(
                effectivePermissionMode,
                selectedModelDefault ?? DEFAULT_MODEL,
                shownProvider,
                configuredProviders,
                runner.modelCatalog,
              )
            : effectivePermissionMode
        ] ?? 'Default'
      : null
    : pickedModeSeed;

  // Mode follows the same context/dirty invariant as Model. This matters when a configured
  // provider resolves after the draft first renders: Auto may need to clamp to Default for its
  // effective model, but that late result must not replace a Mode the user already picked.
  useEffect(() => {
    const decision = decideContextSeed(modeSeedState.current, modelContextKey, !!modeSeed);
    modeSeedState.current = decision.state;
    if (decision.apply && modeSeed) setMode(modeSeed);
  }, [modelContextKey, modeSeed]);

  // Model and Mode have independent dirty guards. If an untouched model is refined by a late
  // Runtime heartbeat after the user explicitly chose Auto, correctness still wins: never keep
  // an invalid pair merely because Mode is dirty.
  useEffect(() => {
    if (
      !live &&
      shownProviderCapabilitiesResolved &&
      ((mode === 'Auto' && !supportsAuto(model, shownProvider, configuredProviders, runner.modelCatalog)) ||
        !permissionModeSupported(MODE_TO_PERMISSION[mode], shownProvider, configuredProviders))
    ) {
      setMode('Default');
    }
  }, [
    configuredProviders,
    live,
    mode,
    model,
    runner.modelCatalog,
    shownProvider,
    shownProviderCapabilitiesResolved,
  ]);

  // A fresh interactive session starts from the account's last-picked effort. Older workspaces can
  // still carry the per-workspace default that preceded that preference, so use it only when the
  // account has never picked an effort. `??` preserves an explicit account Default (''). Reacts to
  // `me` loading so an untouched pill fills once preferences arrive; the dirty guard preserves a
  // choice made before that request finishes.
  useEffect(() => {
    if (selectedId) return;
    const provider = pickedProvider;
    const seed = newSessionEffortForProvider(
      provider,
      me.data?.preferences?.defaultEffort,
      pickedWorkspace?.effort,
      pickedModelDefault,
      runner.modelCatalog,
      configuredProviders,
    );
    const decision = decideContextSeed(effortSeedState.current, effortContextKey, true);
    effortSeedState.current = decision.state;
    if (decision.apply) setEffort(seed);
  }, [
    selectedId,
    effortContextKey,
    pickedProvider,
    pickedModelDefault,
    pickedWorkspace?.effort,
    me.data?.preferences?.defaultEffort,
    runner.modelCatalog,
    configuredProviders,
  ]);

  // Slot accounting is turn-based: only RUNNING occupies maxConcurrent. A warm or
  // cold AWAITING_INPUT session remains open for replies without blocking another turn.
  // Slots are a whole-runner budget, and this list holds one workspace's page of it, so the
  // runner's own server-side count is the number; the list is only a fallback for a
  // payload that predates it.
  const slotUsage = useMemo(
    () => runnerSlotUsage(sessions, runner.maxConcurrent),
    [sessions, runner.maxConcurrent],
  );
  const activeSlots =
    typeof runner.activeSessions === 'number' ? runner.activeSessions : slotUsage.active;
  // The gate comes from the selected session's own row: only the server can tell whether the
  // runner, this run, or the batch is what is holding it.
  const slotWaitDescription = pendingSlotDescription(
    activeSlots,
    runner.maxConcurrent,
    (selectedSession ?? selected) as QueuedGate | null,
  );
  const selectedStartingSession = selectedSession ?? selected;
  const selectedIsQueued = selected
    ? sessionRunStateOf(selectedStartingSession) === 'QUEUED'
    : false;
  const antigravityQueueRepair = selectedIsQueued && runtimeForProvider(shownProvider, configuredProviders) === 'antigravity'
    ? antigravityRepair(selectedStartingSession?.error ?? '')
    : null;
  const dshQueueRepair = selectedIsQueued && runtimeForProvider(shownProvider, configuredProviders) === AgentProvider.DSH
    ? dshRepair(selectedStartingSession?.error ?? '')
    : null;
  const queuedNoticeScope = selectedId
    ? `${selectedId}:${selectedStartingSession?.lastTurnAt ?? ''}`
    : null;
  const delayedQueuedNotice = useDelayedFlag(
    selectedIsQueued && selectedStartingSession?.queuedReason == null,
    QUEUED_NOTICE_DELAY_MS,
    queuedNoticeScope,
  );
  const showQueuedNotice =
    selectedIsQueued && queuedNoticeVisible(selectedStartingSession, delayedQueuedNotice);
  const selectedIsStarting = selected ? sessionIsStarting(selectedStartingSession) : false;
  // Starting or compacting — see waitingNoticeFor. Its `since` is the clock the notice counts from.
  const selectedWaiting = selected ? waitingNoticeFor(selectedStartingSession) : null;
  // A normal cold start is only a few seconds. Preserve its honest state everywhere else, but
  // keep this explanatory transcript notice out of the common fast path so sending a message does
  // not immediately make a large banner flash below it. Scoped per run (waitingNoticeScope), so
  // neither a 30s compaction keepalive nor a wait turning into a compaction hides it again.
  const showStartingNotice = useDelayedFlag(
    selectedWaiting !== null,
    STARTING_NOTICE_DELAY_MS,
    waitingNoticeScope(selectedId, selectedStartingSession),
  );
  const scopedEvents = useMemo(
    () => (eventsSessionId === selectedId ? events : []),
    [events, eventsSessionId, selectedId],
  );
  const scopedLiveToolOutputs =
    liveToolOutputState.sessionId === selectedId
      ? liveToolOutputState.outputs
      : EMPTY_LIVE_TOOL_OUTPUTS;
  const scopedLiveTaskProgress =
    liveTaskProgressState.sessionId === selectedId
      ? liveTaskProgressState.progress
      : EMPTY_LIVE_TASK_PROGRESS;
  // Which of the workspace's Agent/Workflow calls are still at work — the tray's own list, read the
  // same way, so a card's spinner and its tray row always agree.
  const runningTasks = useMemo(() => {
    const running = new Set<string>();
    const shells = mergeBackgroundShells(serverBgShells, deriveBackgroundShells(events, { sessionLive: live }));
    for (const s of shells) {
      if ((s.kind === 'agent' || s.kind === 'workflow') && s.status === 'running') running.add(s.toolUseId);
    }
    return running;
  }, [events, live, serverBgShells]);
  const taskActivity = useMemo<TaskActivity>(
    () => ({ live: scopedLiveTaskProgress, running: runningTasks }),
    [scopedLiveTaskProgress, runningTasks],
  );
  const visibleAcceptedUserTurns = useMemo(
    () =>
      acceptedUserTurns.filter(
        (turn) =>
          turn.sessionId === selectedId &&
          !acceptedUserTurnLanded(turn, eventsSessionId, scopedEvents),
      ),
    [acceptedUserTurns, eventsSessionId, scopedEvents, selectedId],
  );
  const optimisticTranscriptEvents = useMemo(() => {
    if (visibleAcceptedUserTurns.length === 0) return scopedEvents;
    const lastSeq = scopedEvents.reduce((max, event) => Math.max(max, event.seq), 0);
    return [
      ...scopedEvents,
      ...visibleAcceptedUserTurns.map((turn, index) =>
        acceptedUserTurnEvent(
          turn,
          lastSeq + (index + 1) / (visibleAcceptedUserTurns.length + 1),
        ),
      ),
    ];
  }, [scopedEvents, visibleAcceptedUserTurns]);
  const scopedQueuedTurns = useMemo(
    () => (queuedSessionId === selectedId ? queued : []),
    [queued, queuedSessionId, selectedId],
  );
  const transcriptEvents = useMemo(
    () => transcriptEventsWithDurableDeliveryReceipts(
      optimisticTranscriptEvents,
      scopedQueuedTurns,
    ),
    [optimisticTranscriptEvents, scopedQueuedTurns],
  );
  const visibleQueuedTurns = useMemo(
    () => queuedTurnsOutsideTranscript(scopedQueuedTurns, transcriptEvents),
    [scopedQueuedTurns, transcriptEvents],
  );
  // The render-time filter above removes duplication in the same frame the SSE event lands. Trim
  // the acknowledged copy afterwards so landed turns do not accumulate in memory.
  useEffect(() => {
    if (!selectedId) return;
    setAcceptedUserTurns((current) => {
      const next = current.filter(
        (turn) =>
          turn.sessionId !== selectedId ||
          !acceptedUserTurnLanded(turn, eventsSessionId, scopedEvents),
      );
      return next.length === current.length ? current : next;
    });
  }, [acceptedUserTurns, eventsSessionId, scopedEvents, selectedId]);
  // What stands in for an empty transcript — exactly one of these, so the loading skeleton can't
  // stack on top of the centered "waiting for a slot" pane. See lib/transcriptPaint.
  const placeholder = transcriptPlaceholder({
    hasSession: !!selected,
    trashed: selectedTrashed,
    runState: selected ? sessionRunStateOf(selectedSession ?? selected) : null,
    starting: selectedIsStarting,
    live: selected ? isSessionLive(selectedSession ?? selected) : false,
    eventCount: transcriptEvents.length,
    seeding,
    streaming: !!streamingText || !!streamingThink,
  });
  // Null when nothing is being generated, so the transcript can skip splitting itself in two
  // (and keep grouping runs of tool calls across the seam) whenever there are no drafts to place.
  const streamingDrafts = useMemo(
    () =>
      streamingText || streamingThink
        ? { text: streamingText, think: streamingThink, thinkStartedAt: thinkStartedAt ?? undefined }
        : null,
    [streamingText, streamingThink, thinkStartedAt],
  );
  // Mirror the live reasoning and its start into the refs the SSE handler reads, so a block that
  // closes with no text of its own can be settled from what was streamed.
  useEffect(() => {
    streamingThinkRef.current = streamingThink;
  }, [streamingThink]);
  useEffect(() => {
    thinkStartedAtRef.current = thinkStartedAt;
  }, [thinkStartedAt]);

  // Mirror the live composer text into a ref. Declared before the switch effect so that
  // on a commit changing both `text` and `draftKey` (e.g. send → navigate + clear) this
  // runs first and the switch effect reads the latest text.
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // On a target switch, stash the outgoing draft under its key and restore the incoming
  // one (empty if none). Resets the history cursor so recall starts fresh per target.
  useEffect(() => {
    if (prevDraftKey.current === draftKey) return;
    drafts.current.set(prevDraftKey.current, textRef.current);
    setText(drafts.current.get(draftKey) ?? '');
    setHistIdx(-1);
    setHistDraft('');
    prevDraftKey.current = draftKey;
  }, [draftKey]);

  // Subscribe to the session's event stream; reset only when the selection changes.
  useEffect(() => {
    setEventsSessionId(selectedId);
    setQueuedSessionId(selectedId);
    // Keep API-accepted turns across navigation. Rendering is session-scoped above, the list is
    // bounded to 32, and returning to this session lets its matching durable user event retire the
    // transient copy. Dropping it here creates a visible REST debounce gap and loses it entirely
    // when startup fails after acceptance but before the first user event.
    // Live/ephemeral drafts belong to the previous selection — clear them at once.
    setStreamingText('');
    setStreamingThink('');
    setLiveToolOutputState((current) =>
      current.sessionId === selectedId && current.outputs.size === 0
        ? current
        : { sessionId: selectedId, outputs: EMPTY_LIVE_TOOL_OUTPUTS },
    );
    setLiveTaskProgressState((current) =>
      current.sessionId === selectedId && current.progress.size === 0
        ? current
        : { sessionId: selectedId, progress: EMPTY_LIVE_TASK_PROGRESS },
    );
    streamAnchorRef.current = null;
    setApprovals([]);
    setReplyTo(null);
    setQueued([]);
    setLocalStatusCards([]);
    setIdle(false);
    setStuck(null);
    // Staged uploads are scoped to the previous session (can't be linked to another), and
    // the sent-image previews are this session's object URLs — drop and revoke both.
    setImages((prev) => {
      prev.forEach((im) => im.previewUrl && URL.revokeObjectURL(im.previewUrl));
      return [];
    });
    setTurnImages((prev) => {
      Object.values(prev).forEach((refs) => refs.forEach((r) => URL.revokeObjectURL(r.url)));
      return {};
    });
    atBottomRef.current = true; // a freshly opened/switched session starts pinned to the latest
    reviewPositionHeldRef.current = false;
    lastSampleRef.current = TAIL_SAMPLE_ZERO;
    setAtBottom(true); // hide the jump-to-bottom button until the new session reports otherwise
    window.clearTimeout(strandTimerRef.current); // nor is it stranded off a tail not yet drawn
    strandTimerRef.current = undefined;
    setStranded(false);
    // Reset tail-first lazy-loading state for the session being opened.
    prependAnchorRef.current = null;
    loadingOlderRef.current = null;
    jumpingToStartRef.current = false; // a walk to the start belongs to the session it was run on
    setLoadingOlder(false);
    setHasMoreOlder(false); // measure() re-reads it once this session's window is established
    // Every session opens attached to its tail, unless its own link names a record (below).
    newerCursorRef.current = null;
    loadingNewerRef.current = null;
    pendingRecordRef.current = null;
    setDetached(false);
    setLoadingNewer(false);
    if (!selectedId) {
      accRef.current = [];
      setEvents([]);
      seen.current = new Set();
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      followedRecordRef.current = null;
      setSeeding(false);
      return;
    }
    const isSeq = (s: unknown): s is number =>
      typeof s === 'number' && s !== Number.MAX_SAFE_INTEGER;
    const maxSeqOf = (list: RunEvent[]): number =>
      list.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    // A link to one record of this session (`?at=`) opens on the page around that record — not on
    // the cached window, which ends at the tail and may be nowhere near it.
    const openAt = recordAtRef.current;
    followedRecordRef.current = openAt ? `${selectedId} ${openAt}` : null;
    // Seed from cache for an instant paint; touch the entry so it's most-recently-used. On a
    // cache miss the transcript stays empty until boot() fetches the newest page below (no more
    // replaying the whole history over SSE — that's what caused a long session to "fast-forward"
    // on open). The older-pagination boundary is restored from cache, or established by boot().
    const cache = transcriptCache.current;
    const entry = openAt ? undefined : cache.get(selectedId);
    const cached = entry?.events ?? [];
    if (entry) {
      cache.delete(selectedId);
      cache.set(selectedId, entry);
    }
    accRef.current = cached;
    setEvents(cached);
    setSeeding(cached.length === 0); // nothing to paint yet — show the skeleton, not a blank pane
    setServerBgShells([]); // clear the previous session's list until the fetch below repopulates it
    seen.current = new Set(cached.map((e) => e.seq).filter(isSeq));
    oldestSeqRef.current = entry ? entry.oldestSeq : null;
    hasMoreOlderRef.current = entry ? entry.hasMoreOlder : false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Queue refreshes can overlap when another client quickly adds/withdraws turns. Only the most
    // recently requested snapshot may paint, or a slower stale response can resurrect a cancelled
    // row. The snapshot is authoritative for rows known when its request began; reconcile below
    // preserves a local POST that committed while that older request was in flight.
    let queuedRefreshGeneration = 0;
    const refreshQueued = (): void => {
      const generation = ++queuedRefreshGeneration;
      const knownBefore = new Set(queuedRef.current.map((turn) => turn.turnId));
      const knownAcceptedBefore = new Set(
        acceptedUserTurnsRef.current
          .filter((turn) => turn.sessionId === selectedId)
          .map((turn) => turn.key),
      );
      listQueuedTurns(selectedId)
        .then((rows) => {
          if (closed || generation !== queuedRefreshGeneration) return;
          const acceptedRows = rows.filter(
            (row) => turnPlacementOf(row) === 'accepted' && row.kind !== 'shell',
          );
          const accepted = acceptedRows
            .map((row): AcceptedUserTurn => ({
              key: row.turnId,
              sessionId: selectedId,
              source: 'activeSnapshot',
              turnId: row.turnId,
              text: row.content,
              acceptedAt: row.createdAt ?? new Date().toISOString(),
              attachments: (row.attachments ?? []).map((attachment) => ({
                id: attachment.id,
                mime: attachment.mimeType || 'application/octet-stream',
              })),
              // The card the snapshot carried for an exception item's delivery, so the placeholder
              // this row paints is the card the runner's echo will replace it with.
              ...(row.openItemDelivery ? { openItemDelivery: row.openItemDelivery } : {}),
              ...(row.projectStarted ? { projectStarted: row.projectStarted } : {}),
              // …and another session's message, drawn "From [that session]" rather than as the
              // reader's own bubble while its echo is on the way.
              ...(row.sessionMessage ? { sessionMessage: row.sessionMessage } : {}),
            }))
            .filter(
              (turn) => !acceptedUserTurnLanded(turn, selectedId, accRef.current),
            );
          setAcceptedUserTurns((current) =>
            reconcileAcceptedUserTurnSnapshot(
              accepted,
              current,
              selectedId,
              knownAcceptedBefore,
            ),
          );
          const serverQueued = rows.flatMap((row) => {
            const queued = queuedTurnFromActiveSnapshot(row);
            return queued ? [queued] : [];
          });
          const representedTurnIds = new Set(rows.map((row) => row.turnId));
          setQueued((current) =>
            reconcileQueuedTurnSnapshot(
              serverQueued,
              current,
              knownBefore,
              representedTurnIds,
            ),
          );
        })
        .catch(() => undefined);
    };
    // Set when a `final` event arrives: the connection is dropped (don't hold an idle
    // stream to a finished session) but NOT permanently — unlike `closed`, a paused
    // stream can be re-opened in place when the session resumes (see resumeStreamRef).
    let paused = false;
    let fails = 0;
    // Resume just past what's loaded so only the gap is streamed, not the whole history.
    let lastSeq = cached.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
    // The cursor the current connection opened at, and how many connections in a row have died
    // without moving it. A reconnect that resumes from the same seq re-requests the same replay,
    // so a cursor the client can't get past is a loop, not a retry — see reseed().
    let seqAtConnect = -1;
    let stalled = 0;
    const writeCache = (): void => {
      // A window opened at a record ends at a gap, not at the tail: a reopen must not resume from it.
      if (newerCursorRef.current !== null) return;
      const snapshot = {
        events: accRef.current,
        oldestSeq: oldestSeqRef.current,
        hasMoreOlder: hasMoreOlderRef.current,
      };
      cache.set(selectedId, snapshot);
      if (cache.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined && oldest !== selectedId) cache.delete(oldest);
      }
      // Mirror into the persistent L2 so the same transcript survives a reload. Returns at once —
      // this runs on every appended event, and the store batches the actual write into an idle
      // callback rather than opening a transaction per token.
      saveTranscript(selectedId, snapshot);
    };
    const seedAbort = new AbortController();
    // Pending release of the events the first paint held back (see firstPaintSlice).
    let paintRest: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (paintRest) clearTimeout(paintRest);
      es?.close();
      // Scrubbing the list fires one tail page per session passed through (they're no longer
      // debounced — see below); aborting the superseded one keeps at most a single seed in
      // flight instead of a burst the user will never look at.
      seedAbort.abort();
    };
    const push = (ev: RunEvent): void => {
      accRef.current = [...accRef.current, ev];
      writeCache();
      setEvents(accRef.current);
    };
    const applyLiveTaskEvent = (ev: RunEvent): void => {
      setLiveTaskProgressState((current) => {
        const base = current.sessionId === selectedId ? current.progress : EMPTY_LIVE_TASK_PROGRESS;
        const progress = reduceLiveTaskProgress(base, ev);
        return current.sessionId === selectedId && progress === current.progress
          ? current
          : { sessionId: selectedId, progress };
      });
    };
    const applyLiveToolEvent = (ev: RunEvent): void => {
      setLiveToolOutputState((current) => {
        const base =
          current.sessionId === selectedId ? current.outputs : EMPTY_LIVE_TOOL_OUTPUTS;
        const outputs = reduceLiveToolOutputs(base, ev);
        return current.sessionId === selectedId && outputs === current.outputs
          ? current
          : { sessionId: selectedId, outputs };
      });
    };
    /**
     * Throw the loaded window away and start over from a tail page, exactly as a cold open does.
     *
     * Two callers, one situation: the cursor this tab holds is not a viable place to resume from.
     * The server says so with `resync` when the gap is too long to replay; the stall counter below
     * infers it when reconnecting from the same seq keeps failing to advance it. Both used to be
     * unrecoverable in place — the tab reconnected from that cursor forever, re-downloading the
     * same replay while the session it was watching ran on without it.
     *
     * Resetting `seen` and the pagination boundary along with the events is what makes this a real
     * re-seed rather than a patch over a hole: the tail page re-establishes both.
     */
    const reseed = async (): Promise<void> => {
      accRef.current = [];
      seen.current = new Set();
      setLiveToolOutputState({ sessionId: selectedId, outputs: EMPTY_LIVE_TOOL_OUTPUTS });
      setLiveTaskProgressState({ sessionId: selectedId, progress: EMPTY_LIVE_TASK_PROGRESS });
      oldestSeqRef.current = null;
      hasMoreOlderRef.current = false;
      lastSeq = 0;
      stalled = 0;
      try {
        const page = await reseedWithActiveSnapshot(
          () => getSessionEventPage(selectedId, {
            tail: TAIL_PAGE,
            signal: seedAbort.signal,
          }),
          () => { if (!closed) refreshQueued(); },
        );
        if (closed) return;
        accRef.current = page.events;
        for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
        oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
        hasMoreOlderRef.current = page.hasMore;
        lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), 0);
        setEvents(accRef.current);
        writeCache();
      } catch {
        // Leave lastSeq at 0 and let the reconnect below carry it: a cursor-less connect is
        // server-capped, so the fallback for a failed re-seed is still a bounded replay.
      }
      if (closed) return;
      // `fails` is deliberately NOT reset: re-seeding is a different way to spend the same retry
      // budget, not a fresh start. Zeroing it would turn the give-up below into an unreachable
      // branch — a permanently broken stream would reconnect, stall, re-seed, forever.
      connect();
    };
    const connect = (): void => {
      seqAtConnect = lastSeq;
      es = new EventSource(sessionEventsUrl(selectedId, lastSeq));
      es.onmessage = (e) => {
        fails = 0; // a message means the stream is healthy
        const ev = JSON.parse(e.data) as RunEvent;
        // Server keepalive (~20s): a health byte with no seq/payload, sent so an idle transcript
        // stream isn't reaped by Cloudflare. Discard it by type before the reducer below, which
        // would otherwise dedup-miss (seq undefined) and append it as a junk transcript row.
        if (ev.type === 'ping') return;
        // The server refused to replay our gap — it's longer than it will stream (SSE_GAP_CAP).
        // Handled here, before the seq bookkeeping and the dedup below, because it rides seq 0
        // like the approval nudges. Re-seed from a tail page instead; this connection is spent.
        if (ev.type === 'resync') {
          es?.close();
          void reseed();
          return;
        }
        // A still-PENDING turn is not in the transcript stream until the runner leases it.
        // Re-fetch the durable queue when another web/native client adds or withdraws one.
        if (ev.type === 'queued_turns_changed') {
          refreshQueued();
          return;
        }
        // Whole-output snapshots for a foreground `!` shell are live animation, like the text
        // deltas below: replace their side-channel value and return before advancing lastSeq,
        // entering `seen`, or writing the transcript cache. A runner restart/reconnect must never
        // turn one into durable history or make its ephemeral seq the resume cursor.
        if (ev.type === 'tool_output') {
          applyLiveToolEvent(ev);
          return;
        }
        // How far a background agent or workflow has got: animation like the snapshot above — the
        // task's end (a durable background_task) carries the last of it into the transcript.
        if (ev.type === 'task_progress') {
          applyLiveTaskEvent(ev);
          return;
        }
        if (ev.type === 'background_task' || (ev.type === 'system' && ev.payload?.subtype === 'resumed')) {
          applyLiveTaskEvent(ev);
        }
        // The durable result wins in the same render that appends it. Clearing here also releases
        // the potentially large snapshot once the result has entered the ordinary transcript.
        if (
          ev.type === 'tool_result' ||
          ev.type === 'turn_end' ||
          ev.payload?.final ||
          (ev.type === 'system' && ev.payload?.subtype === 'resumed')
        ) {
          applyLiveToolEvent(ev);
        }
        if (typeof ev.seq === 'number' && ev.seq !== Number.MAX_SAFE_INTEGER) {
          lastSeq = Math.max(lastSeq, ev.seq);
        }
        if (ev.payload?.final) {
          // Session finalized (turn-complete failure, idle-recycle, or a user end). Drop
          // the live connection so we don't hold an idle stream — but a gracefully-ended
          // session is resumable IN PLACE (same selectedId, so this effect
          // doesn't re-run), and a resumed turn's events would be published to a stream
          // we'd have permanently closed, leaving the open transcript stale while the
          // polled sidebar advances. So pause instead of closing for good; the liveness
          // watcher re-opens it (replaying the missed seq) once the session is live again.
          paused = true;
          es?.close();
          // However the run ended, no turn is in flight any more. `turn_end` is the
          // only other event that says so, and a run that died before its first one —
          // an engine that failed during session setup, a crash before the first
          // reply — never emits it. Without this the console keeps the turn state of
          // a session that is already terminal: a half-streamed bubble left mid-air,
          // and the next message queued behind a turn that will never end.
          setIdle(true);
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
          streamAnchorRef.current = null;
          // A snapshot started before this terminal signal must not resurrect an accepted/queued
          // fallback after the terminal cleanup below.
          queuedRefreshGeneration += 1;
          setAcceptedUserTurns((current) =>
            clearAcceptedUserTurnsForSession(current, selectedId),
          );
          return;
        }
        // Streaming increment: append to the in-progress assistant bubble. Don't
        // dedup or store it — it's pure animation; the trailing `assistant` event
        // carries the authoritative full text and finalizes the bubble.
        //
        // The first chunk of a stretch also fixes where that bubble sits: at the cursor as it
        // stands now, so a mid-turn message the runner echoes back renders below it rather than
        // above. See streamAnchorAfter for what moves that anchor afterwards.
        if (ev.type === 'text_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') {
            streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
            setStreamingText((p) => p + chunk);
          }
          return;
        }
        if (ev.type === 'thinking_delta') {
          const chunk = ev.payload?.text;
          if (typeof chunk === 'string') {
            streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
            setStreamingThink((p) => p + chunk);
            // The first chunk of a stretch starts its clock; the rest ride the one already running.
            setThinkStartedAt((at) => at ?? Date.now());
          }
          return;
        }
        // Approval nudges (live-only, seq 0) — handle BEFORE the seq dedup, which is
        // keyed on seq and would drop the second one. They drive `approvals`, not the
        // transcript reducer.
        if (ev.type === 'approval_request') {
          const p = ev.payload as { id: string; toolName: string; input: unknown; toolUseId?: string };
          setApprovals((prev) =>
            prev.some((x) => x.id === p.id)
              ? prev
              : [
                  ...prev,
                  { ...p, sessionId: selectedId, status: 'PENDING', createdAt: new Date().toISOString() } as ApprovalInfo,
                ],
          );
          return;
        }
        if (ev.type === 'approval_resolved') {
          const id = ev.payload?.id as string | undefined;
          if (id) setApprovals((prev) => prev.filter((x) => x.id !== id));
          return;
        }
        if (seen.current.has(ev.seq)) return;
        seen.current.add(ev.seq);
        // A block the provider closes with no text of its own would otherwise take its reasoning
        // with it: the draft is cleared just below, and an empty durable event renders nothing.
        // Keep what was streamed — and how long it took — on this LOCAL copy of the event. It is
        // never sent back, so a reload still reads the server's empty text and still renders
        // nothing, which is deliberate (see lib/thinkingDraft).
        if (ev.type === 'thinking') {
          const patch = settleThinking(
            ev.payload?.text,
            streamingThinkRef.current,
            thinkStartedAtRef.current,
            Date.now(),
          );
          push(Object.keys(patch).length ? { ...ev, payload: { ...ev.payload, ...patch } } : ev);
        } else {
          push(ev);
        }
        // The authoritative full text (or a turn/user/interrupt boundary) supersedes
        // the live drafts — clear them so streamed text isn't rendered twice. Text
        // implies thinking is done, so a text/turn boundary clears both; the durable
        // `thinking` block clears only its own draft. A mid-turn crash skips turn_end
        // and re-spawns with a `resumed` system event — clear there too so a partial
        // bubble can't outlive its turn. (Don't clear on every system event: claude's
        // stderr also arrives as `system` and would wipe an in-progress bubble.)
        // A steer is the one `user` event that is NOT a boundary — see supersedesLiveDrafts.
        // Where the drafts belong afterwards is streamAnchorAfter's call: a boundary ends the
        // stretch they were anchored to, while the model's own output (a closed thinking block,
        // a tool call) moves the anchor past itself so what is still being generated follows it.
        if (supersedesLiveDrafts(ev)) {
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
        } else if (ev.type === 'thinking') {
          setStreamingThink('');
          setThinkStartedAt(null);
        } else if (ev.type === 'system' && ev.payload?.subtype === 'resumed') {
          setStreamingText('');
          setStreamingThink('');
          setThinkStartedAt(null);
        }
        streamAnchorRef.current = streamAnchorAfter(streamAnchorRef.current, ev, lastSeq);
        // Track turn boundaries live so the composer re-enables the instant a turn
        // ends, rather than waiting for the 4s session poll.
        if (ev.type === 'turn_end') {
          setIdle(true);
          setAcceptedUserTurns((current) =>
            clearAcceptedUserTurnsForTurn(current, selectedId, ev.turnId),
          );
          // The terminal boundary is persisted and replayable; use it to refresh the active
          // snapshot too, so an accepted placeholder also clears when an older runner omitted the
          // turn id or a queued successor moved into the executable head at the same boundary.
          refreshQueued();
          // Refresh the worktree status bar: the runner reports this turn's diff +
          // isolation on /turn-complete. Delay a touch so that POST (which persists
          // changed_files) lands before we refetch the detail, rather than racing the
          // turn_end event broadcast.
          setTimeout(() => qc.invalidateQueries({ queryKey: ['session', selectedId] }), 400);
        }
        else if (ev.type === 'user') {
          setIdle(false);
          // The runner just picked up this turn — it's now in the transcript, so drop
          // it from the local queue (no-op if it wasn't ours / already cleared). Re-fetch too:
          // an older queue request may have snapshotted this row just before the lease and could
          // otherwise arrive afterwards and resurrect it; the generation fence drops that reply.
          if (ev.turnId) {
            setQueued((q) => q.filter((x) => x.turnId !== ev.turnId));
          }
          refreshQueued();
        }
      };
      es.onerror = () => {
        es?.close();
        if (closed || paused) return;
        // A connection that died without moving the cursor forward left us exactly where we
        // started, so reconnecting asks the server for the same replay again. Once is a dropped
        // connection; three in a row is a replay this tab cannot get through — the shape a single
        // outsized event makes — and the only way out is to stop asking for it. See reseed().
        stalled = lastSeq > seqAtConnect ? 0 : stalled + 1;
        if (stalled >= RESEED_AFTER_STALLED_RECONNECTS) {
          void reseed();
          return;
        }
        // Auto-reconnect, resuming after lastSeq — survives long idle / redeploy
        // drops (the seq dedup set makes any replay overlap harmless).
        if (++fails > 12) return;
        retry = setTimeout(connect, Math.min(2000 * fails, 15000) + Math.random() * 500);
      };
    };
    // Bridge for the liveness watcher: re-open a stream paused by a `final` event once the
    // session is live again. No-op unless paused (so it's safe to call on any status tick);
    // reconnect resumes from lastSeq, so the server replays the turns missed while paused.
    resumeStreamRef.current = () => {
      if (closed || !paused) return;
      paused = false;
      fails = 0;
      // A window opened at a record stays off the stream until it reaches the tail (joinLiveRef).
      if (newerCursorRef.current !== null) return;
      connect();
    };
    /**
     * Make the page around a record the loaded window. Its older edge is set from the page's `before`
     * cursor, as a tail page's `hasMore` would set it; where the page stops short of the latest event
     * the newer edge stays open (newerCursorRef) and the stream stays closed, since what it streams
     * belongs past the gap. The record is brought into view once its row has rendered.
     */
    const applyRecordPage = (page: TranscriptAroundPage): void => {
      accRef.current = page.events;
      seen.current = new Set(page.events.map((e) => e.seq).filter(isSeq));
      oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
      hasMoreOlderRef.current = page.before !== null;
      lastSeq = maxSeqOf(page.events);
      newerCursorRef.current = page.after;
      setDetached(page.after !== null);
      // Drafts streamed into the window being replaced are not this window's to show.
      setStreamingText('');
      setStreamingThink('');
      setThinkStartedAt(null);
      streamAnchorRef.current = null;
      // The reader came for this record, not the latest message: nothing may pin to the bottom.
      atBottomRef.current = false;
      setAtBottom(false);
      pendingRecordRef.current = { sessionId: selectedId, seq: page.anchor.seq };
      setRecordTick((n) => n + 1);
      setEvents(accRef.current);
      setSeeding(false);
      writeCache(); // only a page that reaches the tail is a window a reopen may resume from
    };
    // A detached window's last newer page reached the latest event: resume the stream from there.
    joinLiveRef.current = () => {
      if (closed) return;
      lastSeq = maxSeqOf(accRef.current);
      writeCache();
      es?.close();
      if (!paused) connect();
    };
    // "Jump to the latest" from a detached window: the latest message is past the gap, so the window
    // is traded for a tail page and the stream reopens from it — reseed() is exactly that.
    backToLatestRef.current = () => {
      if (closed) return;
      es?.close();
      clearTimeout(retry);
      newerCursorRef.current = null;
      pendingRecordRef.current = null;
      setDetached(false);
      void reseed();
    };
    // A record of this session, named by a link followed while it is open. A record already in the
    // window — every seq from its oldest to its newest is loaded — is a scroll; one elsewhere in the
    // history replaces the window with the page around it, exactly as opening the session at it does.
    openRecordRef.current = (recordId: string): void => {
      void (async () => {
        let page: TranscriptAroundPage;
        try {
          page = await getSessionEventPageAround(selectedId, recordId, {
            limit: AROUND_PAGE,
            signal: seedAbort.signal,
          });
        } catch {
          if (!closed) message.info(RECORD_NOT_FOUND);
          return;
        }
        if (closed) return;
        const seq = page.anchor.seq;
        const oldest = oldestSeqRef.current;
        if (oldest !== null && seq >= oldest && seq <= maxSeqOf(accRef.current)) {
          atBottomRef.current = false;
          setAtBottom(false);
          pendingRecordRef.current = { sessionId: selectedId, seq };
          setRecordTick((n) => n + 1);
          return;
        }
        es?.close();
        es = null;
        clearTimeout(retry);
        applyRecordPage(page);
        if (page.after === null && !paused) connect();
      })();
    };
    // Tail-first seed, fired NOW rather than from the debounced block below: on a cache miss it
    // is the only request whose answer the transcript is waiting on, so making it wait out the
    // debounce — behind a whole-history /background scan, no less — was pure dead time under a
    // blank pane. What the debounce protected against is covered by the abort in stop() instead.
    // Null on a cache hit, where the SSE's replay of the gap after the cached seq is enough. The
    // debounced block awaits this before connect(), so the stream still opens at the seq the
    // page established, however long it took.
    const seedTail = async (): Promise<void> => {
      // L2 first: the same transcript, kept in IndexedDB so it outlives the page. A hit skips
      // the tail page entirely — the SSE resumes from the stored max seq and replays only what
      // happened since, exactly as an L1 hit does. A miss (or any error) returns null and falls
      // through to the network below, so this can only save a request, never cost correctness.
      const stored = await loadTranscript(selectedId);
      if (closed) return;
      if (stored && stored.events.length > 0) {
        accRef.current = stored.events;
        for (const e of stored.events) if (isSeq(e.seq)) seen.current.add(e.seq);
        oldestSeqRef.current = stored.oldestSeq;
        hasMoreOlderRef.current = stored.hasMoreOlder;
        lastSeq = stored.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
        const { now, deferred } = firstPaintSlice(stored.events);
        setEvents(now);
        setSeeding(false);
        // Into L1 too, so switching away and back in this page load is synchronous again.
        cache.set(selectedId, stored);
        if (deferred) {
          paintRest = setTimeout(() => {
            if (!closed) setEvents(accRef.current);
          }, 0);
        }
        return;
      }
      // Retry the tail seed a few times before giving up. A transient failure here used to fall
      // straight through to the SSE with lastSeq=0, replaying the whole history (now server-capped,
      // but still a needless full tail). Stop as soon as a page seeds; on total failure fall through.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const page = await getSessionEventPage(selectedId, {
            tail: TAIL_PAGE,
            signal: seedAbort.signal,
          });
          if (closed) return;
          accRef.current = page.events;
          for (const e of page.events) if (isSeq(e.seq)) seen.current.add(e.seq);
          oldestSeqRef.current = page.events.length ? page.events[0].seq : null;
          hasMoreOlderRef.current = page.hasMore;
          lastSeq = page.events.reduce((m, e) => (isSeq(e.seq) ? Math.max(m, e.seq) : m), lastSeq);
          // Paint the newest slice first and release the rest after the browser has drawn it:
          // a full page is a few hundred Markdown bodies to parse and highlight in one
          // synchronous burst, which the user would otherwise spend staring at the skeleton.
          // accRef keeps the whole page throughout, so the SSE and the cache are unaffected,
          // and the remainder lands above a viewport that stays pinned to the tail.
          const { now, deferred } = firstPaintSlice(page.events);
          setEvents(now);
          setSeeding(false); // history is on screen — drop the skeleton
          writeCache();
          if (deferred) {
            // A macrotask, not rAF: rAF callbacks run BEFORE the paint they're queued for,
            // which would merge the two renders and defeat the split.
            paintRest = setTimeout(() => {
              if (!closed) setEvents(accRef.current);
            }, 0);
          }
          return;
        } catch {
          if (closed) return;
          // Last attempt failed: fall through to the SSE (the server caps a cursor-less replay).
          if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      // Every attempt failed. Clear the skeleton anyway rather than spin forever — the SSE
      // replay below is the remaining path to content.
      if (!closed) setSeeding(false);
    };
    // A link to one record: the page around it — or, for a record that is not this session's, the
    // tail, with a note saying the link could not be followed.
    const seedRecord = async (recordId: string): Promise<void> => {
      try {
        const page = await getSessionEventPageAround(selectedId, recordId, {
          limit: AROUND_PAGE,
          signal: seedAbort.signal,
        });
        if (closed) return;
        applyRecordPage(page);
        return;
      } catch {
        if (closed) return;
        message.info(RECORD_NOT_FOUND);
      }
      await seedTail();
    };
    const seed: Promise<void> | null = openAt
      ? seedRecord(openAt)
      : cached.length === 0
        ? seedTail()
        : null;
    // Debounce the rest of the network work: scrubbing the list with the arrow keys shouldn't
    // open (and tear down) a connection — nor re-fetch approvals/queued turns — for each
    // session skipped past. The cached transcript above is already on screen meanwhile.
    const start = setTimeout(() => {
      // Pending approvals aren't in the event stream (separate table) — fetch them so
      // a refresh/deep-link shows any request already awaiting a decision.
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
      // Same for queued messages: a still-PENDING turn emits no event until the runner
      // picks it up, so switching away and back (or a refresh/deep-link) would lose the
      // visible queue — restore it from the DB, the source of truth.
      refreshQueued();
      // The complete background-shell list (all launches, output recovered from Read polls) —
      // the loaded event window only holds the most recent launches, so without this the tray
      // under-counts a long session. Merged with the live-derived overlay in the tray. Throttled
      // per session (BG_TTL_MS): this scans the session's whole history, so a re-open within the
      // window paints the cached shells instead of re-running it. A failed fetch isn't cached, so
      // it retries next open.
      const loadBackgroundShells = (): void => {
        const bgCached = bgCacheRef.current.get(selectedId);
        if (bgCached && Date.now() - bgCached.at < BG_TTL_MS) {
          setServerBgShells(bgCached.shells);
          return;
        }
        getBackgroundShells(selectedId)
          .then((shells) => {
            bgCacheRef.current.set(selectedId, { at: Date.now(), shells });
            // Still cache it above (it belongs to `selectedId`, whenever it lands), but only the
            // open session may paint: this now runs after the transcript, so a slow scan can
            // easily outlive the switch away — and `serverBgShells` is one slot, not per-session.
            if (!closed) setServerBgShells(shells);
          })
          .catch(() => undefined);
      };
      // Open the stream once the seed above has established the resume point, so the SSE
      // streams only what's newer than the page (no full-history replay). The seed started at
      // t=0 and this block at t=SWITCH_DEBOUNCE_MS, so on a cache hit — or a seed that already
      // landed — this connects immediately.
      void (async () => {
        await seed;
        if (closed) return;
        // A window opened at a record waits for the reader to reach the tail (joinLiveRef).
        // The reader may have joined already while this startup was debounced.
        if (newerCursorRef.current === null && !es) connect();
        // Last, deliberately: the tray it feeds sits below the fold and nothing else waits on it,
        // whereas the scan behind it is the most expensive read on this path. Issuing it here
        // rather than alongside the seed keeps it from competing for the connection — and, on the
        // server, the event loop — with the one request the transcript is actually waiting for.
        loadBackgroundShells();
      })();
    }, SWITCH_DEBOUNCE_MS);
    return () => {
      resumeStreamRef.current = null;
      openRecordRef.current = null;
      joinLiveRef.current = null;
      backToLatestRef.current = null;
      clearTimeout(start);
      stop();
    };
  }, [selectedId]);

  // A link to a record of the session already open — a footnote, a link in a message, back and
  // forward through them. The session effect above followed the record the session opened with.
  useEffect(() => {
    if (!selectedId || !recordAt) {
      followedRecordRef.current = null;
      return;
    }
    const key = `${selectedId} ${recordAt}`;
    if (followedRecordRef.current === key) return;
    followedRecordRef.current = key;
    openRecordRef.current?.(recordAt);
  }, [selectedId, recordAt]);

  // Polled fallback for idleness, in case an SSE turn_end was missed / reconnected.
  // Also keyed on selectedId so it re-syncs on a session switch: the SSE effect above
  // resets idle→false for the freshly opened session, but switching between two sessions
  // that share a status (both AWAITING_INPUT) wouldn't change `runStatus`, so without the
  // selectedId dep this effect wouldn't re-run and idle would stay wrongly false — flipping
  // turnActive on and hiding the worktree bar's "committed"/merge state until a refresh.
  const runStatus = selectedSession ? sessionRunStatusOf(selectedSession) : undefined;
  // A terminal run has no turn in flight either, and it may have reached that state
  // without a turn_end — so this is the recovery path when the `final` event was the one
  // that got missed. Deliberately the live/terminal split, not "anything but RUNNING":
  // a QUEUED session has nothing running yet, but the next message still has to queue
  // behind the turn it is waiting for.
  const runTerminal = !!selectedSession && isSessionTerminal(selectedSession);
  useEffect(() => {
    // The normalized terminal outcome wins over a stale raw runStatus on rolling-upgrade payloads.
    // AWAITING_INPUT is equally conclusive here: the foreground command has returned, even if its
    // result/turn_end SSE was the event this tab missed.
    if (runTerminal || runStatus === 'AWAITING_INPUT') {
      setIdle(true);
      // SSE `tool_result`/`turn_end`/`final` normally clear this first. This is the missed-event
      // fallback: once the REST/control-plane poll observes idle/terminal, no live output is real.
      setLiveToolOutputState((current) =>
        clearLiveToolOutputsForSession(current, selectedId),
      );
    } else if (runStatus === 'RUNNING') setIdle(false);
  }, [runStatus, runTerminal, selectedId]);

  // A finalized session can be resumed in place (same selectedId, so the SSE effect above
  // doesn't re-run and its stream was paused on `final`). When the polled status shows it
  // live again, re-open the paused stream so the open transcript catches the resumed turn —
  // otherwise only the sidebar (separately polled) would advance and the conversation would
  // look stuck until a manual refresh.
  useEffect(() => {
    if (live) resumeStreamRef.current?.();
  }, [live]);

  // Tail-first prepend: after loadOlder grows older content above the viewport, restore the
  // scroll position so what the user was reading stays put instead of jumping down. Runs before
  // paint (layout effect), and before the at-bottom follow below (a passive effect) — which
  // no-ops here anyway since prepending only happens while scrolled up (atBottomRef false).
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor) return;
    prependAnchorRef.current = null;
    const el = scrollRef.current;
    if (!el) return;
    // A page the walk to the beginning asked for has no position to hold: keep the top of what has
    // loaded in view, so the last page leaves the reader looking at the start of the conversation.
    el.scrollTop = anchor.toTop ? 0 : el.scrollHeight - anchor.prevHeight + anchor.prevTop;
  }, [events]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    // A content update restarts the wait for a stranded tail (see `stranded`): the follow just above
    // closes the gap the new rows opened, and a gap read before it landed must not count.
    window.clearTimeout(strandTimerRef.current);
    strandTimerRef.current = undefined;
    measure(); // content grew — the in-view prompt may have just scrolled off the top
  }, [
    transcriptEvents,
    streamingText,
    streamingThink,
    scopedLiveToolOutputs,
    approvals,
    visibleQueuedTurns,
    localStatusCards,
    measure,
  ]);

  // The record a link named (`?at=`): once its row has rendered, bring it into view and mark it for a
  // moment. A row not rendered yet leaves the request standing for the next render of the transcript.
  useEffect(() => {
    const pending = pendingRecordRef.current;
    const root = scrollRef.current;
    if (!pending || !root || pending.sessionId !== selectedId) return;
    const row = elementForSeq(root, pending.seq);
    if (!row) return;
    pendingRecordRef.current = null;
    const view = root.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    root.scrollTop += recordScrollDelta(
      { top: view.top, height: root.clientHeight },
      { top: box.top, height: box.height },
    );
    // Restarted, not just added, so a second link to the same row marks it again.
    row.classList.remove('record-flash');
    void row.offsetWidth;
    row.classList.add('record-flash');
    window.setTimeout(() => row.classList.remove('record-flash'), RECORD_FLASH_MS);
  }, [transcriptEvents, recordTick, selectedId]);

  // Track at-bottom + which prompt to surface as the user scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    // The reader's own hand on the scroller — a wheel, a finger, the scrollbar, an arrow key.
    // Without it a scrollTop that falls because a reasoning row folded is indistinguishable from
    // one that falls because they dragged up, and the transcript stops following the live reply
    // (tailPinning.ts). `pointerdown` is what catches a scrollbar drag, which fires none of the rest.
    const onReaderInput = (): void => {
      reviewPositionHeldRef.current = false;
      readerInputAtRef.current = performance.now();
    };
    const onReviewRevealed = (): void => {
      reviewPositionHeldRef.current = true;
      atBottomRef.current = false;
      setAtBottom(false);
    };
    el.addEventListener(REVIEW_CARD_REVEALED, onReviewRevealed);
    const readerEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    for (const type of readerEvents) el.addEventListener(type, onReaderInput, { passive: true });
    // The events-driven pin above only re-scrolls when the transcript's *content* changes, so
    // it misses growth the container itself causes. On mobile the conversation pane is
    // display:none until a session is opened, so the open-time scroll runs against a
    // zero-height box and never lands at the tail; and the composer's worktree status bar
    // loads in async, shrinking the scroll area after the fact. Re-pin to the tail on any such
    // resize while the user is still at the bottom.
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
    });
    ro.observe(el);
    // Content growing INSIDE the scroller — the last card opened under a reader at the bottom, a link
    // card landing — neither resizes nor scrolls it, so the tail could leave the view with nothing
    // re-measuring. Its rows are watched for that, to measure only: whether to follow stays the
    // content-change effect's call, and following here would pull an opened card out from under the
    // reader.
    const rows = new ResizeObserver(() => measure());
    for (const row of el.children) rows.observe(row);
    const rowsAddedOrGone = new MutationObserver((records) => {
      for (const record of records) {
        for (const row of record.addedNodes) if (row instanceof Element) rows.observe(row);
        for (const row of record.removedNodes) if (row instanceof Element) rows.unobserve(row);
      }
    });
    rowsAddedOrGone.observe(el, { childList: true });
    // Screenshots load after their <img> lays out at zero height, so the content grows *below*
    // the tail without an events change. `load` doesn't bubble but fires in the capture phase,
    // so one listener on the scroller catches every image and re-pins.
    const onLoad = (e: Event): void => {
      if (atBottomRef.current && e.target instanceof HTMLImageElement)
        el.scrollTo({ top: el.scrollHeight });
    };
    el.addEventListener('load', onLoad, { capture: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener(REVIEW_CARD_REVEALED, onReviewRevealed);
      for (const type of readerEvents) el.removeEventListener(type, onReaderInput);
      el.removeEventListener('load', onLoad, { capture: true });
      ro.disconnect();
      rows.disconnect();
      rowsAddedOrGone.disconnect();
    };
  }, [selectedId, measure]);

  /**
   * Which approvals in hand are still questions somebody can answer.
   *
   * `SessionsService.listApprovals` already drops a dead card on two committed facts and no clock
   * (`stillBeingAsked`), but that filter is only reachable by a fetch — and this component fetches
   * approvals exactly twice: when a session is opened, and after one is answered. The card a person
   * sees mid-turn came neither way. It arrived as an `approval_request` frame and went straight
   * into `approvals`, and when the engine abandons the call it publishes no `approval_resolved` and
   * writes nothing anywhere, so nothing takes it back out again: it stays on screen and stays
   * pressable, and the answer reaches nobody because the poll loop that would have consumed it died
   * with the turn (`docs/completion-input-routing.md` §A2 D1). Nothing polls it back to the truth.
   *
   * So the same facts are recomputed here, from rows this component already holds. Which facts
   * depends on the card's reader, exactly as on the server: an in-turn card is answerable while
   * the session is still generating and the call it was raised for has no result yet, and a card
   * that names a runner-hosted job (`backgroundJobId`, migration 0291) is answerable while that
   * process is up — the job outlives the turn, which is why the server offers such a card on a
   * PARKED conversation and this predicate has to agree with it rather than take the card down
   * with the turn. The failure direction is the server's — a card is taken out of the answerable
   * set on evidence that it is over, never on the absence of evidence — so a session row that has
   * not arrived yet, a session row with no shell list on it (the list payload carries the count
   * and not the ids), and an old runtime's approval with no tool_use id to pair, all stay
   * answerable. Not a clock: elapsed time is not a committed fact (`coordinator-wake.ts` §0).
   */
  const settledToolUseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of transcriptEvents) {
      if (ev.type !== 'tool_result') continue;
      const id = (ev.payload as { toolUseId?: unknown } | undefined)?.toolUseId;
      if (typeof id === 'string') ids.add(id);
    }
    return ids;
  }, [transcriptEvents]);
  const turnStillGenerating =
    !selectedSession || isGenerating(selectedSession, sessionRunStateOf(selectedSession));
  // The live processes this session reported, or null when the row in hand says nothing about them
  // (the list carries the count, never the ids) — which is not evidence that a job is gone.
  const liveBackgroundJobIds = Array.isArray(selectedSession?.runningBgShells)
    ? new Set(selectedSession.runningBgShells)
    : null;
  const readByLiveJob = (a: ApprovalInfo): boolean =>
    !!a.backgroundJobId && (liveBackgroundJobIds === null || liveBackgroundJobIds.has(a.backgroundJobId));
  const answerableApprovalIds = new Set(
    approvals
      .filter(
        (a) =>
          readByLiveJob(a) ||
          (turnStillGenerating && !(a.toolUseId && settledToolUseIds.has(a.toolUseId))),
      )
      .map((a) => a.id),
  );
  // Questions submit only through their button, so they must not hold Enter against a later create.
  const activeApprovalId = approvals.find(
    (a) => a.toolName !== 'AskUserQuestion' && answerableApprovalIds.has(a.id),
  )?.id;
  // The same read the pinned strip and the evidence card are drawn from — the same query key, so
  // this shares their cached read and adds no request.
  const pendingDecisions = useQuery({
    ...pendingDecisionsQuery(selectedId ?? ''),
    enabled: Boolean(selectedId) && !selectedTrashed,
  });

  // What this project's owner has answered about its ruler, drawn into the transcript at the moment
  // each was decided (`CriteriaDecisionReceipt` below) — the criteria half of the receipts, on the
  // same query key the delivered card is drawn from, so it costs no request. A reload used to take
  // a decided proposal out of the conversation altogether: no card (a settled question is not a
  // question) and no receipt (that was state in the page that pressed).
  const coordinatedProjectId = selectedSession?.projectId ?? null;
  const criteriaDecisions = useQuery({
    ...pendingCriteriaDecisionsQuery(coordinatedProjectId ?? ''),
    enabled: Boolean(coordinatedProjectId) && !selectedTrashed,
  });
  // Where the answers pressed in this window were sent: the door hands the reply to the window that
  // pressed and to nobody else. Keyed by intent, which names exactly one project, so a press from
  // one conversation can never be read as one from another.
  const [criteriaReplies, setCriteriaReplies] = useState<
    Record<string, CriteriaDecisionReply | null>
  >({});

  // The confirmation somebody signed for this project's criteria, for the record of it
  // (`AcceptanceConfirmationReceipt` below) — the fourth receipt, on the same query key the
  // settlement card asks its question from, so a press there draws the record here with no second
  // request. Distinct from the card: WHETHER the question is still open is the card's business and
  // is asked of the same read (`SessionAcceptanceConfirmationCard`).
  const acceptanceConfirmation = useQuery({
    ...acceptanceConfirmationQuery(coordinatedProjectId ?? ''),
    enabled: Boolean(coordinatedProjectId) && !selectedTrashed,
  });
  // What a re-confirmation pressed in this window changed — "1 new, 1 stricter" — which only the
  // change card knew at the press (`confirmedChangesProjectKey`). Never fetched: once a set is confirmed
  // nothing is left changed, so there is nothing to ask the server for, and a receipt drawn
  // without it says the seal and the count.
  const confirmedChanges = useQuery({
    queryKey: confirmedChangesProjectKey(coordinatedProjectId ?? ''),
    queryFn: (): string | null => null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // The merges this project has already made, for the record each one leaves where it happened
  // (`ProjectPromotionReceipt` below). NOT the read the strip's card is drawn from: that one is the
  // candidate on offer, and it moves on to the next one — a receipt drawn from it would describe a
  // different merge every time the branch was offered again, which is exactly what the card at the
  // bottom of this pane used to do. Polled with the card, because a conversation that is open is
  // where somebody watches their own merge land.
  const mergedPromotions = useQuery({
    ...projectMergedPromotionsQuery(coordinatedProjectId ?? ''),
    enabled: Boolean(coordinatedProjectId) && !selectedTrashed,
    refetchInterval: 20_000,
  });

  // The candidate on offer, read HERE as well as inside the strip's card below, for the one state
  // the strip does not keep: a candidate a check blocked has a moment, and where that moment falls
  // is a fact about this conversation's own events (`transcriptEvents`), which only this view
  // holds. Same query key as the card's own read, so the two share one request. Polled, because a
  // blocked candidate is still moving — somebody is resolving it — and the card drawn from it says
  // who and for how long.
  const currentPromotion = useQuery({
    ...projectPromotionQuery(coordinatedProjectId ?? ''),
    enabled: Boolean(coordinatedProjectId) && !selectedTrashed,
    refetchInterval: 20_000,
  });

  // What this project still owes somebody, for the exceptions drawn into the transcript at the
  // moment each happened (`exceptionCardRows` below, `ItemAsCard`). The same read the project page
  // and the coordinator's other cards use, and polled with the merges above: a conversation that is
  // open is where somebody watches their own exception arrive and clear.
  const openItems = useQuery({
    ...projectOpenItemsQuery(coordinatedProjectId ?? ''),
    enabled: Boolean(coordinatedProjectId) && !selectedTrashed,
    refetchInterval: 20_000,
  });

  // Which of those rows the pinned strip lists: the ones the evidence card below is drawn for, by
  // the card's own filter over the same read, the project this session coordinates and this
  // session itself (a dispatched task's card names the one conversation it is drawn in). The strip
  // counts and points at those and no others; a row this conversation draws no card for is counted
  // by the conversation that draws it.
  const decisionCards = new Set(
    evidenceDecisionCardRows(
      pendingDecisions.data ?? null,
      selectedSession?.projectId ?? null,
      selectedId,
    ).map(decisionRowKey),
  );

  // The confirmation of the OWNER_CONFIRMED task this session runs, through the key the card below
  // and the task panel read too, so this adds no request. It says whether a run of THIS session is
  // waiting on its owner — the card is drawn and the pinned line points at it — and which decisions
  // answered this session's runs, for their receipts.
  const selectedTaskId: string | null = selectedSession?.taskId ?? null;
  const ownerConfirmation = useQuery({
    ...ownerConfirmationQuery(selectedTaskId ?? ''),
    enabled: Boolean(selectedTaskId) && !selectedTrashed,
  });
  const ownerWaiting = ownerConfirmationWaitingIn(ownerConfirmation.data, selectedId);
  // The send-back the composer completes. It presses the same door the card's own confirm
  // presses, and re-reads the same views after it; it lives here rather than in the card because
  // the press that finishes it happens at the composer, after the card armed it.
  const ownerDecision = useMutation({
    mutationFn: (press: { taskId: string; requestId: string; decision: 'SEND_BACK'; note: string }) =>
      sendOwnerDecision(press.taskId, press.requestId, press.decision, press.note),
    // Said as staleness when that is what the door's code means, for the reason the card gives: a
    // reader told only "it failed" has been told the button is broken.
    onError: (error: Error) => {
      const refusal = ownerDecisionRefusal(error);
      message.error("Couldn't send the task back", refusal.stale ? refusal.title : error.message);
    },
    onSettled: (_data, _error, press) => refreshOwnerConfirmationViews(qc, press.taskId),
  });
  // The send-back the composer completes from the evidence card's "Chat about this": it presses the
  // same door the card's own confirm presses, from the same session — the door checks that
  // the deciding session is independent of the submission, so it is the session the card is drawn
  // in and not the browser that answers. It re-reads the queue after it, which is where the receipt
  // for this decision comes from. It lives here rather than in the card because the press that
  // finishes it happens at the composer, after the card armed it.
  const evidenceDecision = useMutation({
    mutationFn: (press: {
      sessionId: string;
      decidingSessionId: string;
      taskId: string;
      evidenceRevision: string;
      note: string;
    }) => sendEvidenceDecision(press, press.decidingSessionId, 'SEND_BACK', press.note),
    // Said as staleness when that is what the door's code means, for the reason the card gives: a
    // reader told only "it failed" has been told the button is broken.
    onError: (error: Error) => {
      const refusal = evidenceDecisionRefusal(error);
      message.error("Couldn't send the task back", refusal.stale ? refusal.title : error.message);
    },
    onSettled: (_data, _error, press) =>
      qc.invalidateQueries({ queryKey: pendingDecisionsQuery(press.sessionId).queryKey }),
  });
  // A run ending its turn moves this session's row, not the task, so no task event re-reads the
  // confirmation. Re-read it when the row moves, and the card arrives with the report rather than
  // on the card's next poll.
  // The row's review status is in it too: a reviewer that ends, answers or runs out of time moves
  // this row and nothing about the task (contract §5 N5), and the card has to follow the row.
  const selectedRunMoment = `${selectedSession?.runState ?? ''}|${selectedSession?.lastTurnAt ?? ''}|${
    selectedSession?.confirmationUnderReview?.requestId ?? ''}`;
  useEffect(() => {
    if (!selectedTaskId) return;
    void qc.invalidateQueries({ queryKey: ownerConfirmationQuery(selectedTaskId).queryKey });
  }, [qc, selectedTaskId, selectedRunMoment]);

  // The decisions this conversation has recorded, drawn into the transcript at the moment each was
  // made (`EvidenceDecisionReceipt`, `CriteriaDecisionReceipt`, `OwnerDecisionReceipt`,
  // `AcceptanceConfirmationReceipt`). Memoized because `Transcript` is: a fresh array on every
  // render would rebuild the whole conversation with it. Each row carries the moment it is placed
  // by, because a record whose moment is older than every loaded event leads at the head of the
  // window and the ones that do are ordered by it (`TranscriptInsert`).
  const decisionReceipts = useMemo(
    () => [
      ...criteriaDecisionReceiptRows(criteriaDecisions.data, transcriptEvents, criteriaReplies)
        .map((row) => ({
          anchor: row.placement,
          moment: row.settled.decidedAt,
          key: `criteria-receipt:${row.settled.intentId}`,
          element: <CriteriaDecisionReceipt settled={row.settled} reply={row.reply} />,
        })),
      ...(pendingDecisions.data?.decided ?? []).flatMap((decided) => {
        const anchor = decisionReceiptAnchor(transcriptEvents, decided.decidedAt);
        return anchor === null
          ? []
          : [{
              anchor,
              moment: decided.decidedAt,
              key: `evidence-receipt:${decisionRowKey(decided)}`,
              element: <EvidenceDecisionReceipt decided={decided} />,
            }];
      }),
      ...ownerDecisionReceiptsIn(ownerConfirmation.data, selectedId).flatMap((decided) => {
        const anchor = decisionReceiptAnchor(transcriptEvents, decided.decidedAt);
        const view = ownerConfirmation.data;
        return anchor === null || !view
          ? []
          : [{
              anchor,
              moment: decided.decidedAt,
              key: `owner-decision-receipt:${decided.id}`,
              element: (
                <OwnerDecisionReceipt
                  view={view}
                  decided={decided}
                  // Offered where the review that came in later found problems, once the task has
                  // settled — the task panel's own Reopen task (contract §9 L4).
                  reopen={<OwnerConfirmationReopen taskId={view.taskId} projectId={view.projectId} status={view.status} />}
                />
              ),
            }];
      }),
      // A report its reviewer sent back to the run: the card it was is drawn as the record it
      // became, at the moment it was sent back (contract §8 B6).
      ...reviewerReturnsIn(ownerConfirmation.data, selectedId).flatMap((returned) => {
        const at = returned.review.returned?.recordedAt;
        const anchor = at ? decisionReceiptAnchor(transcriptEvents, at) : null;
        return anchor === null || !at || !ownerConfirmation.data
          ? []
          : [{
              anchor,
              moment: at,
              key: `owner-confirmation-returned:${returned.requestId}`,
              element: <ReviewerReturnRecord view={ownerConfirmation.data} returned={returned} />,
            }];
      }),
      // The set somebody signed for this project, at the moment they signed it. This one is the
      // settlement card's record and not its question: held by the card, it sat at the BOTTOM of
      // the pane for the life of the project — under every later message, in conversations started
      // long after, and after the project was done — which is where the questions that are open NOW
      // belong. The native clients place it the same way (`AcceptanceConfirmations.receipt` +
      // `ReceiptAnchor.place`), and a moment older than every loaded event puts it at the HEAD of
      // the window rather than at the bottom of it.
      ...[acceptanceConfirmation.data?.confirmation].flatMap((confirmation) => {
        if (!confirmation) return [];
        const anchor = decisionReceiptAnchor(transcriptEvents, confirmation.confirmedAt);
        return anchor === null
          ? []
          : [{
              anchor,
              moment: confirmation.confirmedAt,
              key: `acceptance-receipt:${confirmation.confirmedAt}`,
              element: (
                <AcceptanceConfirmationReceipt
                  confirmation={confirmation}
                  changed={confirmedChanges.data ?? null}
                />
              ),
            }];
      }),
      // And the merges this project has made, each at the moment it made it. The strip draws only
      // the candidate that is asking NOW (`drawRecords={false}` below): held there as well,
      // this record sat under every later message for the life of the project — in conversations
      // started long afterwards, and after the project was done — which is where the questions that
      // are open NOW belong. Anchored by `mergedAt`, which is the terminal edge's own clock on a row
      // that never moves again; a merge older than every loaded event leads at the head, like every
      // other record here (`decisionReceiptAnchor`).
      ...(mergedPromotions.data ?? []).flatMap((promotion) => {
        // A candidate with no `merged` is not a record: no moment, so nothing to place.
        const mergedAt = promotionRecordMoment(promotion);
        if (mergedAt === null) return [];
        const anchor = decisionReceiptAnchor(transcriptEvents, mergedAt);
        return anchor === null
          ? []
          : [{
              anchor,
              moment: mergedAt,
              key: `promotion-receipt:${promotion.promotionId}`,
              element: <ProjectPromotionReceipt promotion={promotion} />,
            }];
      }),
    ],
    [
      acceptanceConfirmation.data,
      confirmedChanges.data,
      criteriaDecisions.data,
      criteriaReplies,
      mergedPromotions.data,
      pendingDecisions.data,
      ownerConfirmation.data,
      selectedId,
      transcriptEvents,
    ],
  );

  // "Chat about this" on the exception cards and the blocked-merge card (`lib/coordinatorChat`): the
  // next send is an ordinary turn to this conversation, with the card's facts — the project, the
  // item, what failed and where its handling stands — carried in front of the reader's sentence. It
  // presses no door: the coordinator reads it and acts with the doors it has, and the card's own
  // presses stay where they were.
  const chatProjectTitle = selectedSession?.projectTitle ?? null;
  // The card's facts as they read at `now`: at the press, for the bar, and again at the send.
  const coordinatorChatContext = useCallback(
    (subject: CoordinatorChatSubject, projectId: string, now: number): string =>
      subject.kind === 'item'
        ? openItemChatContext({ projectTitle: chatProjectTitle, projectId, row: subject.row, now })
        : promotionChatContext({
            projectTitle: chatProjectTitle,
            projectId,
            promotion: subject.promotion,
            item: subject.item,
            now,
          }),
    [chatProjectTitle],
  );
  const startCoordinatorChat = useCallback(
    (subject: CoordinatorChatSubject) => {
      if (!coordinatedProjectId) return;
      setReplyTo({
        target: { kind: 'coordinatorChat', projectId: coordinatedProjectId, about: chatAboutOf(subject) },
        banner:
          subject.kind === 'item'
            ? openItemChatBanner(subject.row)
            : promotionChatBanner(subject.promotion),
        placeholder: COORDINATOR_CHAT_PLACEHOLDER,
        context: coordinatorChatContext(subject, coordinatedProjectId, Date.now()),
      });
      setTimeout(() => taRef.current?.focus(), 0);
    },
    [coordinatedProjectId, coordinatorChatContext],
  );
  // The press itself, as the cards drawn in this conversation make it: armed here when this IS the
  // project's coordinator conversation — the one the read names for the item — and otherwise taken
  // to that one (an earlier coordinator of the same project, say, still draws the project's cards),
  // which arms its own composer on arrival.
  const chatAboutThis = useCallback(
    (subject: CoordinatorChatSubject) => {
      const item = subject.kind === 'item' ? subject.row : subject.item;
      const coordinator = item ? itemChat(item).sessionId : null;
      if (coordinator && routeId(coordinator) !== selectedId) {
        navigate(coordinatorChatPath(coordinator, subject));
        return;
      }
      startCoordinatorChat(subject);
    },
    [navigate, selectedId, startCoordinatorChat],
  );

  // The exceptions this project still owes somebody, drawn into the transcript at the moment each
  // became the owner's (`exceptionCardRows`) instead of as a block under it — where a card that
  // happened thirty-four minutes ago sat under the newest message saying `waiting 34m`, which is
  // two different stories about when it happened. The moment is the item's own (`escalatedAt`, else
  // `waitingSince`), read off the same fields the card's heading counts its wait from, and placed by
  // the same rule the records above are (`decisionReceiptAnchor`); both native clients do the same
  // (`DeliveryAnchor.exception`), so no end can disagree about where one exception goes.
  //
  // `dataUpdatedAt` is in the deps because the cards count their wait from NOW: an element built
  // once and kept would freeze "waiting 2h" at the moment it was built, and react-query's structural
  // sharing means an unchanged poll leaves `data` the same object. A poll that changed nothing still
  // moves `dataUpdatedAt`, which is exactly the tick these labels need.
  const exceptionCards = useMemo(
    () =>
      exceptionCardRows(openItems.data, transcriptEvents).flatMap(({ row, anchor }) => {
        if (anchor === null || !coordinatedProjectId) return [];
        return [{
          anchor,
          moment: row.escalatedAt ?? row.waitingSince,
          key: `open-item:${row.itemId}`,
          element: <ItemAsCard projectId={coordinatedProjectId} row={row} now={Date.now()} onChat={chatAboutThis} />,
        }];
      }),
    [chatAboutThis, coordinatedProjectId, openItems.data, openItems.dataUpdatedAt, transcriptEvents],
  );

  // Which of those cards the owner answers by pressing — an exception that became theirs, the pause
  // only they can lift — for the pinned line to point at: drawn among the messages rather than at the
  // foot, one of these that scrolled away had nothing pointing at it, while the phone's bar did (the
  // account owner's report, 2026-10-02). The rows the inserts above draw and no others, so a press
  // always has a card to arrive at.
  const ownerExceptionRows = useMemo(
    () =>
      coordinatedProjectId
        ? exceptionCardRows(openItems.data, transcriptEvents)
          .filter(({ row, anchor }) => anchor !== null && isOwnerExceptionCard(row))
          .map(({ row }) => row)
        : [],
    [coordinatedProjectId, openItems.data, transcriptEvents],
  );
  // Which side of the reader each sits on is measured on scroll, and a card can arrive or go on its
  // read's own clock without the conversation moving — so a change in which cards there are is a
  // reason to measure again.
  const ownerExceptionIds = ownerExceptionRows.map((row) => row.itemId).join(' ');
  useEffect(() => {
    measure();
  }, [ownerExceptionIds, measure]);

  // The candidate a check blocked, drawn at the moment it was blocked instead of at the bottom of
  // this pane — where it sat, under every later message, for as long as the block stood, and in a
  // conversation started long afterwards; the owner's report, 2026-09-24 (`promotionRecordMoment`
  // is the rule, and the strip that used to hold it now draws only what is asking or under way).
  //
  // A BLOCKED candidate is still LIVE — the row says who is on it and for how long — so unlike the
  // records above this element is rebuilt on every poll, which is why `dataUpdatedAt` is in the
  // deps (`exceptionCards` carries the same note). Its `project` is null because the blocked card
  // draws no row off the project document: what it says is read from the candidate and the item.
  const blockedPromotionCard = useMemo(() => {
    const current = currentPromotion.data;
    if (!coordinatedProjectId || !current || current.state !== 'BLOCKED') return [];
    // Null for a stamp this build cannot read, which the strip then keeps drawing (the rule and the
    // fallback are both `promotionRecordMoment`'s).
    const blockedAt = promotionRecordMoment(current);
    if (blockedAt === null) return [];
    const anchor = decisionReceiptAnchor(transcriptEvents, blockedAt);
    if (anchor === null) return [];
    const rows = [...(openItems.data?.needsYou ?? []), ...(openItems.data?.withCoordinator ?? [])];
    return [{
      anchor,
      moment: blockedAt,
      key: `promotion-blocked:${current.promotionId}`,
      element: (
        <ProjectPromotionCard
          projectId={coordinatedProjectId}
          promotion={current}
          item={rows.find((row) => row.promotionId === current.promotionId) ?? null}
          project={null}
          now={Date.now()}
          onChat={chatAboutThis}
        />
      ),
    }];
  }, [
    chatAboutThis,
    coordinatedProjectId,
    currentPromotion.data,
    currentPromotion.dataUpdatedAt,
    openItems.data,
    transcriptEvents,
  ]);

  // One array for the transcript, memoized: a fresh array on every render would rebuild the whole
  // conversation with it (`Transcript` memoizes on this prop).
  const transcriptInserts = useMemo(
    () => [...decisionReceipts, ...blockedPromotionCard, ...exceptionCards],
    [decisionReceipts, blockedPromotionCard, exceptionCards],
  );

  // Whether the settlement card below is on screen and still a question, as the card reports it:
  // delivered and put down are the card's own state, so the strip is told rather than left to work
  // out a second answer. Kept with the conversation it was reported in, because this view outlives
  // navigation and the conversation just left must not answer for the next one.
  const [openSettlementIn, setOpenSettlementIn] = useState<{
    sessionId: string;
    question: SettlementQuestion;
  } | null>(null);
  const reportSettlementQuestion = useCallback(
    (question: SettlementQuestion | null) => {
      if (!selectedId) return;
      setOpenSettlementIn((current) =>
        question
          ? { sessionId: selectedId, question }
          : current?.sessionId === selectedId ? null : current,
      );
    },
    [selectedId],
  );
  // Arriving from the project page's "Review" on a request to start (`?intent=start-project`): once
  // this conversation's start card is on screen it is scrolled to and marked, as the pinned strip's
  // press does, and the intent goes, so a refresh does not scroll there again.
  const startIntent = Boolean(selectedId) && searchParams.get('intent') === START_PROJECT_INTENT;
  const startCardShown = openSettlementIn?.sessionId === selectedId && openSettlementIn?.question === 'START';
  useEffect(() => {
    if (!startIntent || !startCardShown || !revealSettlementCard()) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('intent');
        return next;
      },
      { replace: true },
    );
  }, [startIntent, startCardShown, setSearchParams]);
  // Arriving from a "Chat about this" pressed outside this conversation (`?intent=chat-about` with
  // the item or the candidate, `coordinatorChatPath`): once this conversation has read what the
  // chat is about, its composer is armed exactly as the card's own press would arm it, the card is
  // brought into view, and the intent goes, so a refresh does not arm it again. A subject that has
  // left the read since the press — or a candidate no longer blocked — is said rather than armed
  // about (`chatSubjectIn`).
  const chatIntent = selectedId ? chatIntentOf(searchParams) : null;
  const chatIntentItem = chatIntent && 'itemId' in chatIntent ? chatIntent.itemId : null;
  const chatIntentPromotion = chatIntent && 'promotionId' in chatIntent ? chatIntent.promotionId : null;
  // Where an arrival's chat is about, until its card is on screen to be brought into view: the cards
  // are drawn at moments of the transcript (`exceptionCardRows`), which lands after the reads do.
  const [chatReveal, setChatReveal] = useState<{ sessionId: string; about: ChatAbout } | null>(
    null,
  );
  useEffect(() => {
    if (!chatIntentItem && !chatIntentPromotion) return;
    const read = openItems.data;
    if (!read) return;
    // `undefined` is a read on its way; `null` is a project with no candidate on offer.
    if (chatIntentPromotion && currentPromotion.data === undefined) return;
    const subject = chatSubjectIn(
      chatIntentItem ? { itemId: chatIntentItem } : { promotionId: chatIntentPromotion! },
      read,
      currentPromotion.data,
    );
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('intent');
        next.delete('item');
        next.delete('promotion');
        return next;
      },
      { replace: true },
    );
    if (!subject) {
      message.info(CHAT_SUBJECT_GONE);
      return;
    }
    startCoordinatorChat(subject);
    if (selectedId) setChatReveal({ sessionId: selectedId, about: chatAboutOf(subject) });
  }, [
    chatIntentItem,
    chatIntentPromotion,
    currentPromotion.data,
    message,
    openItems.data,
    selectedId,
    setSearchParams,
    startCoordinatorChat,
  ]);
  // The arrival's card, once it is drawn and the transcript under it has landed. The card sits above
  // the newest message, and a transcript still pinned to its tail follows every row that lands —
  // which carried the reader straight back down past it — so the pin is let go first, as a reader
  // scrolling up to it would. The jump is instant: a smooth one is still near the tail when the
  // first scroll is measured, which pins the transcript again, and the next resize (the reply bar
  // this arrival just armed) snaps it back down.
  useEffect(() => {
    if (!chatReveal || chatReveal.sessionId !== selectedId || seeding) return;
    const { about } = chatReveal;
    const card = 'itemId' in about
      ? document.querySelector<HTMLElement>(`[data-open-item="${about.itemId}"]`)
      : document.getElementById(`promotion-${about.promotionId}`);
    if (!card) return;
    atBottomRef.current = false;
    setAtBottom(false);
    if ('itemId' in about) revealOpenItemCard(about.itemId, document, 'auto');
    else card.scrollIntoView?.({ block: 'center' });
    setChatReveal(null);
  }, [chatReveal, currentPromotion.data, openItems.data, seeding, selectedId, transcriptEvents]);
  // The start card's "View tasks": the tasks this conversation filed are the strip above the
  // composer, so it is opened there rather than navigating away from the card being read. The same
  // read the strip is drawn from says whether there is one; without it the card links to the
  // project instead.
  const [createdTasksOpenRequest, setCreatedTasksOpenRequest] = useState(0);
  const viewCreatedTasks = useCallback(() => setCreatedTasksOpenRequest((n) => n + 1), []);
  const createdTasks = useQuery({
    ...sessionCreatedTasksQuery(selectedId ?? ''),
    enabled: Boolean(selectedId) && !selectedTrashed,
  });

  // Allow/deny a pending tool-permission request; optimistically drop it (the
  // approval_resolved SSE also removes it), re-fetching to resync on failure.
  const decide = async (
    approvalId: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    message?: string,
    rememberRules?: PermissionRule[],
  ): Promise<void> => {
    if (!selectedId) return;
    setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
    try {
      await decideApproval(selectedId, approvalId, behavior, message, answers, rememberRules);
    } catch {
      listApprovals(selectedId)
        .then(setApprovals)
        .catch(() => undefined);
    }
  };

  // If the question the composer is replying to gets answered another way (the user picks an
  // option, an SSE approval_resolved arrives, or the confirmation is settled on a phone), drop the
  // reply context so the chip can't dangle over a question that's already gone.
  useEffect(() => {
    if (!replyTo) return;
    if (replyTo.target.kind === 'approval') {
      const id = replyTo.target.id;
      if (!approvals.some((a) => a.id === id)) setReplyTo(null);
      return;
    }
    // Nothing answers a plan change another way: no call is pending on it, so there is no question
    // that can go out from under the reader mid-sentence. It stays armed until it is sent or the
    // chip is dismissed. A chat about an item or a blocked merge is the same: a sentence about one
    // that has since moved is still one the coordinator can act on (the native ends keep theirs too).
    if (replyTo.target.kind === 'planChange' || replyTo.target.kind === 'coordinatorChat') return;
    // An evidence version: the row leaving the pending read is what says it was answered elsewhere
    // or displaced by a newer revision — the two refusals the door gives. Read off the same queue
    // the card is drawn from, and only once that read has come back, for the reason below.
    if (replyTo.target.kind === 'evidenceDecision') {
      const read = pendingDecisions.data;
      if (!read) return;
      const address = decisionRowKey(replyTo.target);
      const still = evidenceDecisionCardRows(
        read, selectedSession?.projectId ?? null, selectedId,
      ).some((row) => decisionRowKey(row) === address);
      if (!still) setReplyTo(null);
      return;
    }
    // The same rule read from the other door — but only once the read has actually come back. A
    // read in flight is "this browser cannot say yet", and disarming on it would throw away a
    // reason somebody is in the middle of typing.
    const view = ownerConfirmation.data;
    if (!view) return;
    const { requestId } = replyTo.target;
    const answered = view.decisions.some((d) => d.requestId === requestId);
    if (answered || ownerWaiting?.requestId !== requestId) setReplyTo(null);
  }, [
    approvals,
    replyTo,
    ownerConfirmation.data,
    ownerWaiting,
    pendingDecisions.data,
    selectedSession?.projectId,
  ]);

  const send = useMutation({
    mutationFn: async (
      vars: ComposerSendVars,
    ): Promise<{
      id: string;
      turnId?: string;
      queuedItem?: QueuedTurn;
      created?: boolean;
      /** Where the message actually landed, when the server routed it to the run that holds this
       *  session's task (`docs/session-message-routing-contract.md` §2.1). */
      routedToSessionId?: string;
      /** The provider this create actually sent, for the remember-on-the-workspace write-back. */
      provider?: string;
      /** The explicitly picked permission mode, for the same write-back. */
      permissionMode?: string;
      clientTurnId: string;
    }> => {
      const { content, images: imgs, shell } = vars;
      const intent: SessionTurnIntent = shell ? 'NEXT_TURN' : (vars.intent ?? 'NEXT_TURN');
      if (selectedTrashed)
        throw new Error('Restore this session to Open before sending a message');
      if (selectedMissing) throw new Error('Session not found');
      if (selected && live && sameSessionSendBlocked)
        throw new Error(sameSessionSendBlockedCopy);
      // Only fully-uploaded images carry an id to reference; onSend blocks while any is
      // still uploading, so this is the complete set. A re-send hands its ids in directly: its
      // files are already on the server and were never staged in this composer.
      const attachmentIds = [
        ...(vars.attachmentIds ?? []),
        ...imgs.map((im) => im.id).filter((x): x is string => !!x),
      ];
      const operation = logicalSendToken(sendOperationRef.current, {
        sessionId: selected?.id ?? null,
        content,
        attachmentIds: [...attachmentIds].sort(),
        kind: shell ? 'shell' : 'message',
        intent,
        model,
        permissionMode: MODE_TO_PERMISSION[mode],
        effort,
        provider: pendingResumeProvider ?? pickedProvider,
      });
      sendOperationRef.current = operation;
      // Continue a live session; revive an ended-but-resumable one (same row, claude
      // --resumes its context); otherwise (no selection, or unresumable) start fresh.
      // New-draft uploads are unscoped and can follow CREATE. Uploads made while viewing an
      // existing session belong to that session, so a terminal CREATE fallback blocks below
      // and keeps the chips visible instead of passing invalid attachment ids or dropping them.
      if (selected && live) {
        const res = await sendTurn(
          selected.id,
          content,
          attachmentIds,
          shell ? 'shell' : undefined,
          intent,
          operation.clientTurnId,
        );
        // The server decides this under the same Session row lock as enqueue/claim. Missing
        // placement is a protocol error; local idle state is never used to infer delivery.
        const placement = turnPlacementOf(res);
        // The optimistic row carries the refs this send referenced, so withdrawing it before the
        // server snapshot comes round (which is authoritative, and does carry them) still hands the
        // files back to the composer. A re-send knows only the ids it was given; the snapshot fills
        // in what each one is a moment later.
        const attachments = [
          ...imgs.flatMap((im) => (im.id ? [{ id: im.id, mimeType: im.mime }] : [])),
          ...(vars.attachmentIds ?? []).map((id) => ({ id, mimeType: '' })),
        ];
        const queuedItem =
          placement === 'accepted'
            ? undefined
            : {
                turnId: res.turnId,
                content,
                shell,
                placement,
                ...(res.targetTurnId ? { targetTurnId: res.targetTurnId } : {}),
                ...(attachments.length ? { attachments } : {}),
              };
        return { id: selected.id, turnId: res.turnId, queuedItem, clientTurnId: operation.clientTurnId };
      }
      if (selected && !live) {
        // Capabilities can change with heartbeat/context cleanup, so never POST /resume from a
        // cached terminal decision (positive or negative). Re-read detail immediately; if another
        // client already made it live, honor fresh canSend, if its context is now available resume
        // it, and only then fall back to a fresh run.
        const fresh = await getSession(selected.id);
        qc.setQueryData(sessionQuery(selected.id).queryKey, fresh);
        const freshReason = sessionResumeBlockedReasonOf(fresh);
        const freshLegacyResumable = !!fresh.startedAt && !!runner.online;
        const disposition = sessionSendDispositionOf(fresh, freshLegacyResumable);
        if (disposition === 'BLOCK')
          throw new Error(
            sessionSendBlockedMessage(
              sessionLifecycleStateOf(fresh) === 'TRASH' ? 'TRASHED' : freshReason,
            ),
          );
        if (disposition === 'SEND') {
          const res = await sendTurn(
            selected.id,
            content,
            attachmentIds,
            shell ? 'shell' : undefined,
            intent,
            operation.clientTurnId,
          );
          const placement = turnPlacementOf(res);
          const queuedItem =
            placement === 'accepted'
              ? undefined
              : {
                  turnId: res.turnId,
                  content,
                  shell,
                  placement,
                  ...(res.targetTurnId ? { targetTurnId: res.targetTurnId } : {}),
                };
          return { id: selected.id, turnId: res.turnId, queuedItem, clientTurnId: operation.clientTurnId };
        }
        if (disposition === 'RESUME') {
          // The pills were seeded from this session's stored config, so an untouched
          // send keeps it and an edited Mode/Model/Effort/Provider is re-applied on resume.
          // A `!cmd` revives via a shell turn: claude --resumes (context restored) and the
          // runner runs the command, buffering its output for the next message.
          const provider =
            pendingResumeProvider ??
            fresh.provider ??
            selected.provider ??
            detailForSelected?.provider ??
            'claude';
          const wireEffort = normalizeEffortForProvider(
            provider,
            effort,
            model,
            runner.modelCatalog,
            configuredProviders,
          );
          const res = await resumeSession(
            selected.id,
            content,
            // Keep '' so choosing Default explicitly clears a stale stored variant.
            {
              model,
              permissionMode: MODE_TO_PERMISSION[mode],
              effort: wireEffort,
              fastMode,
              ...(pendingResumeProvider ? { provider: pendingResumeProvider } : {}),
              ...(pendingResumeAccount ? { account: pendingResumeAccount } : {}),
            },
            attachmentIds,
            shell ? 'shell' : undefined,
            operation.clientTurnId,
            vars.stopSessionId,
          );
          // The task moved on to another run and the server delivered this there. Nothing was
          // placed on THIS row, so there is no placement to honour and no bubble to paint here —
          // onSuccess follows the message instead.
          const routedToSessionId = routedToSession(res);
          if (routedToSessionId)
            return { id: selected.id, routedToSessionId, clientTurnId: operation.clientTurnId };
          // A genuinely terminal revive is accepted. If another client revived the row between
          // the capability read and this request, /resume routes through live createTurn and its
          // row-locked placement preserves a real queued/steer state here.
          const placement = turnPlacementOf(res);
          const queuedItem =
            placement === 'accepted'
              ? undefined
              : {
                  turnId: res.turnId,
                  content,
                  shell,
                  placement,
                };
          return { id: selected.id, turnId: res.turnId, queuedItem, clientTurnId: operation.clientTurnId };
        }
        if (attachmentIds.length > 0)
          throw new Error(scopedAttachmentCreateBlockedMessage(attachmentIds.length));
        // Fall through to createInteractiveSession: terminal non-resumable sessions keep the
        // established "start a new session" behavior instead of sending an invalid resume.
      }
      const provider = pickedProvider;
      // Harness levels are opaque catalogue values, so they are checked against the model's own row.
      const wireEffort =
        runtimeForProvider(provider, configuredProviders) === AgentProvider.DSH
          ? normalizeEffortForProvider(provider, effort, model, runner.modelCatalog, configuredProviders)
          : normalizeEffortForProvider(provider, effort);
      const providerResolved = providerIdentityResolved(
        provider,
        configuredProvidersLoaded,
      );
      const modelWasEdited =
        modelSeedState.current.contextKey === modelContextKey && modelSeedState.current.dirty;
      const modeWasEdited =
        modeSeedState.current.contextKey === modelContextKey && modeSeedState.current.dirty;
      // Never turn an unresolved custom-provider slug into an explicit Claude model. If provider
      // discovery is still pending/failed, omit the untouched override and let the server resolve
      // the configured provider's own default. Once resolved, derive from the current seed rather
      // than waiting for the post-render state effect to catch up.
      const createModel =
        providerResolved || selected?.model
          ? modelWasEdited
            ? model
            : (selected ? selectedModelDefault : pickedModelDefault) ?? model
          : undefined;
      const createPermissionMode = selected
        ? MODE_TO_PERMISSION[mode]
        : modeWasEdited
          ? MODE_TO_PERMISSION[mode]
          : providerResolved
            ? MODE_TO_PERMISSION[pickedModeSeed ?? mode]
            : undefined;
      const created = await createInteractiveSession({
        prompt: content,
        assignedRunnerId: runner.id,
        workspaceId,
        // Only an explicit pick travels: leaving it off keeps the server's inherit-from-workspace
        // path, so a session started without touching the hero behaves exactly as before.
        provider: draftProvider ?? undefined,
        model: createModel,
        permissionMode: createPermissionMode,
        // Send even '' (Default) explicitly: the composer already seeds the pill from the workspace's
        // default, so the pill is authoritative — an explicit Default must stick, not fall back to
        // the workspace's effort server-side (session.effort ?? workspace.effort). Task runs omit it, so
        // those still inherit the workspace default.
        effort: wireEffort,
        // Only when it is on. Off is the server's default and the engine's, so saying it is the
        // one way this could disagree with either of them later.
        ...(fastMode ? { fastMode: true } : {}),
        // Only an explicit pick, as with the provider: none is Automatic, or the workspace's account.
        ...(draftCodexAccount && pickedProvider === 'codex' ? { codexAccount: draftCodexAccount } : {}),
        ...(draftClaudeAccount && pickedProvider === 'claude' ? { claudeAccount: draftClaudeAccount } : {}),
        attachmentIds,
        // A `!cmd` draft seeds the session's first turn as a shell command, not a message.
        shell,
        // Composed on a folder's page: the session starts in that folder.
        ...(openFolder && openFolder.workspaceId === workspaceId ? { folderId: openFolder.id } : {}),
      });
      // Only an *edited* Mode is worth remembering on the workspace: the untouched seed is the Auto
      // default, possibly clamped for this provider (Auto -> Default on a model that can't run
      // it), and writing that back would erase the workspace's real stored mode.
      return {
        id: created.id,
        created: true,
        permissionMode: modeWasEdited ? MODE_TO_PERMISSION[mode] : undefined,
        clientTurnId: operation.clientTurnId,
      };
    },
    onSuccess: (
      { id, turnId, queuedItem, created, permissionMode: sentMode, clientTurnId, routedToSessionId },
      vars,
    ) => {
      if (sendOperationRef.current?.clientTurnId === clientTurnId) {
        sendOperationRef.current = null;
      }
      pushHistory(id, vars.shell ? `!${vars.content}` : vars.content); // record under the resolved session id, new sessions included
      // Delivered, to the run that has this task rather than to the one it was typed in. Nothing
      // about this row changed, so none of the optimistic painting below applies — the bubble is
      // in the other session. Say where it went, clear the composer (it WAS sent), and take the
      // reader there, which is the half the old 409 never did.
      if (routedToSessionId) {
        setRunConflict(null);
        setHandedOverTo(routedToSessionId);
        setText((draft) => composerDraftAfterSend(draft, true));
        setComposerRefs({});
        setImages([]);
        setView('open');
        qc.invalidateQueries({ queryKey: ['sessions'] });
        navigate(`/sessions/${encodeId(routedToSessionId)}`);
        return;
      }
      // For a freshly created session, prime its detail cache so the sidebar resolves
      // its workspace row synchronously. Otherwise activeWorkspaceId (TasksSidePanel) falls
      // back to keepPreviousData — the previously open session's workspace — and the
      // highlight blips to that workspace until this session's fetch lands. Mirrors
      // getSession's shape; the background refetch fills in the rest.
      if (created)
        qc.setQueryData(sessionQuery(id).queryKey, {
          id,
          assignedRunnerId: runner.id,
          workspace: workspaceId ? { id: workspaceId } : null,
        });
      // The provider pick is deliberately not written back — see DRAFT_PROVIDER_PREFIX. The session
      // carries its own binding, and the workspace's default keeps meaning "what this project starts
      // on", including for the runs nobody is watching.
      //
      // The Mode pick is different: without a write-back it lived on that one session only, and
      // a task-launched run inherits the ACCOUNT default server-side, so an edited pick is written
      // back there — one place, not one per checkout, which is the point of the move off Workspace.
      // Best-effort: a failed PATCH costs a remembered default, never a wrong dispatch.
      if (created && sentMode && sentMode !== accountDefaultPermissionMode) {
        qc.setQueryData<any>(meQuery().queryKey, (old: any) =>
          old ? { ...old, preferences: { ...old.preferences, defaultPermissionMode: sentMode } } : old,
        );
        void api('/users/me/preferences', {
          method: 'PATCH',
          body: { defaultPermissionMode: sentMode },
        })
          .then(() => qc.invalidateQueries({ queryKey: meQuery().queryKey }))
          .catch(() => {});
      }
      navigate(sessionPath(id));
      setText((draft) => composerDraftAfterSend(draft, true));
      setComposerRefs({});
      // Hand the sent image previews to the transcript, keyed by turnId, so they show in
      // the user bubble immediately (the runner echoes the text + attachment refs). Only
      // inline images have a local object URL; files render from the durable ref echo. The
      // URLs move here as-is — setImages([]) below drops the chips without revoking them.
      const previews = vars.images.filter((im) => im.previewUrl);
      if (turnId && previews.length) {
        const refs: TurnImage[] = previews.map((im) => ({ url: im.previewUrl as string, mime: im.mime }));
        setTurnImages((m) => ({ ...m, [turnId]: refs }));
      } else if (created && previews.length) {
        // The create path has no turnId to key local previews on (the runner seeds the
        // first turn), so free these object URLs — the seeded turn's `user` event carries
        // the attachment refs and the transcript fetches them back for display.
        previews.forEach((im) => im.previewUrl && URL.revokeObjectURL(im.previewUrl));
      }
      setImages([]);
      setView('open'); // a new/continued session lives in Open
      if (queuedItem)
        setQueued((current) =>
          current.some((turn) => turn.turnId === queuedItem.turnId)
            ? current.map((turn) =>
                turn.turnId === queuedItem.turnId ? { ...turn, ...queuedItem } : turn,
              )
            : [...current, queuedItem],
        );
      else {
        setIdle(false); // a turn is now starting
        // Shell sends settle into a Bash card rather than a user bubble. Ordinary accepted sends
        // paint immediately and are replaced, by turn id (or the new session's first user event),
        // as soon as the runner's durable transcript event arrives.
        if (!vars.shell && (turnId || created)) {
          const key = turnId ?? `initial:${id}`;
          setAcceptedUserTurns((current) =>
            [
              ...current.filter((turn) => turn.key !== key),
              {
                key,
                sessionId: id,
                source: 'local' as const,
                turnId,
                text: vars.content,
                acceptedAt: new Date().toISOString(),
                attachments: vars.images.flatMap((image) =>
                  image.id
                    ? [
                        {
                          id: image.id,
                          mime: image.mime || 'application/octet-stream',
                          name: image.name,
                        },
                      ]
                    : [],
                ),
              },
            ].slice(-32),
          );
        }
      }
      qc.invalidateQueries({ queryKey: ['sessions'] });
      // Reviving moves the row from Completed to Open server-side (see SessionsService.resume),
      // so refetch the detail too — otherwise the header ⋮ keeps offering Move to Open for a
      // session that's already back in Open.
      qc.invalidateQueries({ queryKey: ['session', id] });
    },
    onError: (e: Error, vars) => {
      // A CURRENT_WORK refusal placed nothing and needs no decision: the message becomes the
      // ordinary next turn it would have been had it been typed a moment later. This is the
      // synchronous half of a fallback the delivery path already performs on its own — a steer
      // the runner can prove never reached the engine is re-filed as a NEXT_TURN message on the
      // same row — so the two ways of missing the turn now read the same to whoever sent one.
      //
      // Terminates: the retry carries NEXT_TURN, which the server never answers with this code.
      if (isCurrentWorkUnavailable(e) && vars.intent === 'CURRENT_WORK') {
        send.mutate({ ...vars, intent: 'NEXT_TURN' });
        return;
      }
      setText((draft) => composerDraftAfterSend(draft, false));
      // One of the refusals about who holds this task. They arrive structured — a stable code, the
      // run in the way, whether it is letting go — and `message.error(e.message)` is exactly the
      // line that threw that away and put the server's English on screen. Anything this build has
      // no reading for still goes to the toast below, server's words and all.
      const conflict = readTaskRunConflict(e);
      if (conflict) {
        setHandedOverTo(null);
        setRunConflict({ conflict, vars });
        return;
      }
      message.error("Couldn't send the message", e.message);
    },
  });
  const sendMutateForConflict = send.mutate;
  // How many times this message has been held for a holder that was letting go. A ref and not
  // state because it must survive the resend it causes: each resend produces its own refusal, and
  // a counter reset by that would never reach its own bound.
  const endingResendsRef = useRef(0);
  // A holder that is letting go frees the task on its own, so this waits instead of asking. The
  // resend carries the same `clientTurnId` — `logicalSendToken` mints one per distinct payload and
  // this payload is unchanged — so a delivery that in fact landed is not duplicated by it.
  useEffect(() => {
    if (runConflict?.conflict.kind !== 'ENDING') {
      endingResendsRef.current = 0;
      return;
    }
    // Whatever is holding that engine is no longer the shutdown this was waiting for. Stop, and
    // say the true thing — rather than a request every two seconds for as long as the tab is open.
    if (endingResendsRef.current >= TASK_RUN_RESEND_MAX_ATTEMPTS) {
      setRunConflict((current) =>
        current && current.conflict.kind === 'ENDING'
          ? { ...current, conflict: stillHeldAfterWaiting(current.conflict) }
          : current,
      );
      return;
    }
    const vars = runConflict.vars;
    const timer = setTimeout(() => {
      endingResendsRef.current += 1;
      setRunConflict(null);
      sendMutateForConflict(vars);
    }, runConflict.conflict.resendAfterMs ?? TASK_RUN_RESEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [runConflict, sendMutateForConflict]);
  // A conflict is about ONE send in ONE session; carrying it to the next session would ask the
  // reader to answer a question about a run they are no longer looking at.
  useEffect(() => {
    setRunConflict(null);
    // …except the one that says where a message WENT: following it is what changes the selection,
    // so clearing on that change would take the explanation away at the moment it is arrived at.
    setHandedOverTo((to) => (to && to === selectedId ? to : null));
  }, [selectedId]);
  const clearTaskPin = useMutation({
    mutationFn: (taskId: string) =>
      api(`/tasks/${taskId}`, { method: 'PATCH', body: { provider: null, model: null } }),
    onSuccess: () => {
      setRunConflict(null);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e: Error) => message.error("Couldn't clear the task's pin", e.message),
  });
  /**
   * The reader's answer to whichever question the conflict asked.
   *
   * `STOP_AND_CONTINUE` is the only path that stops a run, and it re-sends the SAME message with
   * the confirmation the server asked for — never a flag remembered from a previous answer, and
   * never a value derived from some other refusal that happened to name a session.
   */
  const answerRunConflict = (action: TaskRunConflictAction): void => {
    if (!runConflict) return;
    if (action.kind === 'KEEP_RUNNING') {
      setRunConflict(null);
      return;
    }
    if (action.kind === 'CLEAR_PIN') {
      if (runConflict.conflict.taskId) clearTaskPin.mutate(runConflict.conflict.taskId);
      return;
    }
    if (action.kind === 'STOP_AND_CONTINUE') {
      const stopSessionId = stopSessionIdFor(runConflict.conflict, true);
      if (!stopSessionId) return;
      const vars = runConflict.vars;
      setRunConflict(null);
      sendMutateForConflict({ ...vars, stopSessionId });
    }
  };
  const control = useMutation({
    mutationFn: (id: string) => interruptSession(id),
    onSuccess: () => {
      // Interrupt drops queued follow-ups server-side. Rather than silently lose what the
      // user typed, fold their queued text back into the composer so it can be edited and
      // resent — the composer is guaranteed empty here (showStop only offers Stop with an
      // empty composer), so this never clobbers an in-progress draft. Their attachments come
      // back the same way: the messages are already being merged into one draft, so the files
      // they were sent with are staged together under it.
      // Only what somebody typed: a wake, a delivery or an acceptance round was never theirs.
      const theirs = visibleQueuedTurns.filter(returnsToComposer);
      const restored = theirs
        .map((q) => {
          const body = q.content.trim();
          return body && q.shell ? `!${body}` : body; // a `!cmd` comes back as one
        })
        .filter(Boolean)
        .join('\n\n');
      if (restored) setText(restored);
      stageRestored(theirs.flatMap((q) => q.attachments ?? []));
      setQueued([]);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error("Couldn't stop the session", e.message),
  });
  // Withdraw a queued message. Optimistically remove it; if the runner already leased
  // it (it's no longer cancellable) it'll arrive in the transcript via its `user` event.
  const cancelQueued = async (turnId: string): Promise<void> => {
    if (!selectedId) return;
    const withdrawn = queued.find((x) => x.turnId === turnId);
    setQueued((q) => q.filter((x) => x.turnId !== turnId));
    try {
      await cancelQueuedTurn(selectedId, turnId);
      // Withdrawing shouldn't silently eat what the user typed (interrupt parity): fold the
      // message back into the composer so it can be edited and resent. Only restored once the
      // DELETE succeeds — a rejected withdraw means the runner already leased it, so it lands
      // in the transcript and restoring would duplicate it. Unlike Stop (offered only with an
      // empty composer), Cancel is reachable mid-draft, so an in-progress draft always wins —
      // read through textRef, since the awaited gap may have outdated this render's `text`.
      // Nor does a turn nobody typed come back (`returnsToComposer`).
      const body = withdrawn && returnsToComposer(withdrawn) ? withdrawn.content.trim() : '';
      if (body && !textRef.current.trim()) {
        setText(withdrawn?.shell ? `!${body}` : body);
        // The files follow the words: restoring them under a draft that kept its place would stage
        // one message's images against another's text.
        stageRestored(withdrawn?.attachments);
      }
    } catch {
      message.info('This message is already being processed and cannot be withdrawn');
    }
  };
  // Withdraw a wake a watch queued. Nobody typed it, so unlike a message nothing folds back into the
  // composer — and it is gone for good: the server dead-letters the watch's delivery (WAKE_WITHDRAWN)
  // and the watch never sends it again. That is why this one asks first, where Cancel does not.
  const withdrawWake = (turnId: string): void => {
    const sessionId = selectedId;
    if (!sessionId) return;
    modal.confirm({
      title: 'Withdraw this wake?',
      content: WAKE_WITHDRAW_CONSEQUENCE,
      okText: 'Withdraw wake',
      okButtonProps: { danger: true },
      cancelText: 'Keep it queued',
      onOk: async () => {
        setQueued((q) => q.filter((x) => x.turnId !== turnId));
        try {
          await cancelQueuedTurn(sessionId, turnId);
        } catch {
          message.info('This wake is already being processed and cannot be withdrawn');
        }
      },
    });
  };
  // Lifecycle actions happen immediately and offer Undo; Complete also ends a live run.
  const refreshProjectSession = (id: string, knownProjectId?: string): void => {
    const projectId = knownProjectId ?? projectMembers.find((s) => s.id === id)?.projectMembership?.projectId ??
      visibleSessions.find((s) => s.id === id)?.projectMembership?.projectId ??
      projectData.coordinators.find((s) => s.id === id)?.projectMembership?.projectId;
    if (projectId) void qc.invalidateQueries({ queryKey: ['project-sessions', projectId] });
  };
  const restoreMut = useMutation({
    mutationFn: (session: SessionToastTarget & { notify: boolean }) => restoreSession(session.id),
    onSuccess: (_d, session) => {
      setView('open');
      refreshProjectSession(session.id, session.projectId);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: ['session', session.id] });
      if (session.notify) {
        message.sessionNotice({
          sessionId: session.id,
          sessionTitle: session.title,
          event: 'restore',
          headline: 'Moved to Open',
          tone: 'info',
          icon: 'undo',
        });
      }
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'restore-error',
        headline: "Couldn't move to Open",
        detail: e.message,
        tone: 'error',
      }),
  });
  const requestRestore = useCallback(
    (session: any): void => {
      const source = selectedSession?.id === session.id ? selectedSession : session;
      if (!sessionCapabilityOf(source, 'canRestore', true)) {
        message.info('This session cannot be moved to Open right now.');
        return;
      }
      restoreMut.mutate({ id: session.id, title: session.title, projectId: source.projectMembership?.projectId, notify: true });
    },
    [message, restoreMut, selectedSession],
  );
  const showUndo = (session: SessionToastTarget, action: 'complete' | 'trash'): void => {
    message.sessionAction({
      sessionId: session.id,
      sessionTitle: session.title,
      action,
      onUndo: () => restoreMut.mutate({ ...session, notify: false }),
    });
  };
  // Completing/trashing the Open session drops it from the Open list. Keep the
  // selection at the same row: step to the next session down (or the previous one
  // when we just completed the last row) so the cursor stays put instead of jumping
  // to the top of the list. With nothing left to land on, fall back to the workspace's
  // list (same move as the tab switcher) — that re-scopes the left column (a null
  // `selected` would collapse `scopeWorkspaceId` and leak every workspace's sessions) and
  // shows its empty/compose state. A non-open row leaves the conversation untouched.
  const leaveIfOpen = (id: string): void => {
    if (id !== selectedId) return;
    const idx = orderedSessions.findIndex((s) => s.id === id);
    const next = idx >= 0 ? (orderedSessions[idx + 1] ?? orderedSessions[idx - 1]) : null;
    if (next) {
      navigate(sessionPath(next.id));
      return;
    }
    const a = scopeWorkspaceId ?? workspacesForRunner[0]?.id;
    navigate(a ? `/workspaces/${encodeId(a)}${listSearch}` : `/runners/${encodeId(runner.id)}${listSearch}`);
  };
  // After leaveIfOpen re-scopes to the workspace, the auto-open effect picks that workspace's
  // next session — but it reads the cached list, which still holds the row we just
  // completed/trashed until the refetch lands. Drop it now so auto-open can't re-select
  // the removed session (which would null out `selected`, collapse the workspace scope, and
  // leak every workspace's sessions into the list). The invalidate below still reconciles.
  const dropFromLists = (id: string, projectId?: string): void => {
    qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
      Array.isArray(old) ? old.filter((s) => s.id !== id) : old,
    );
    qc.setQueriesData<any[]>({ queryKey: ['project-sessions'] }, (old) =>
      Array.isArray(old) ? old.filter((s) => s.id !== id) : old,
    );
    refreshProjectSession(id, projectId);
  };
  const completeMut = useMutation({
    mutationFn: (session: SessionToastTarget) => completeSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id, session.projectId);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(session, 'complete');
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'complete-error',
        headline: "Couldn't complete the session",
        detail: e.message,
        tone: 'error',
      }),
  });
  const requestComplete = useCallback(
    (session: any): void => {
      const source = selectedSession?.id === session.id ? selectedSession : session;
      if (!sessionCapabilityOf(source, 'canComplete', true)) {
        message.info('This session cannot be completed right now.');
        return;
      }
      completeMut.mutate({ id: session.id, title: session.title, projectId: source.projectMembership?.projectId });
    },
    [completeMut, message, selectedSession],
  );
  // An open row menu owns the shortcut, including when its Complete action cannot run.
  // Otherwise ⌘/Ctrl+D completes the selected session, even while the composer is focused.
  // Never let a disabled/missing menu action fall through and complete a different session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (menuOpenId && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Restore focus before the controlled dropdown begins its exit animation.
        listRef.current?.querySelector<HTMLButtonElement>('.session-row.menu-open .session-kebab')?.focus();
        setMenuOpenId(null);
        return;
      }
      if (e.key.toLowerCase() !== 'd' || e.shiftKey || e.altKey || e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      if (menuOpenId) {
        e.preventDefault();
        e.stopPropagation();
        const row = orderedSessions.find((s) => s.id === menuOpenId);
        const source = selectedSession?.id === menuOpenId ? selectedSession : row;
        const sourceView = source ? sessionRowView(source) : rowView;
        if (
          !row || sourceView !== 'open' || !source ||
          !isCompleteShortcutEligible(source, sessionLifecycleStateOf(source, { listView: sourceView }))
        ) return;
        setMenuOpenId(null);
        requestComplete(row);
        return;
      }
      if (
        !selected ||
        !isCompleteShortcutEligible(selectedSession, selectedLifecycleState)
      )
        return;
      e.preventDefault();
      setHeaderMenuOpen(false);
      requestComplete(selected);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuOpenId, orderedSessions, rowView, sessionRowView, selected, selectedSession, selectedLifecycleState, requestComplete]);
  useEffect(() => {
    if (menuOpenId && !orderedSessions.some((s) => s.id === menuOpenId) &&
      !folderListing.projects.some((p) => p.id === menuOpenId)) setMenuOpenId(null);
  }, [menuOpenId, orderedSessions, folderListing.projects]);
  const deleteMut = useMutation({
    mutationFn: (session: SessionToastTarget) => deleteSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id, session.projectId);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      showUndo(session, 'trash');
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'trash-error',
        headline: "Couldn't move to Trash",
        detail: e.message,
        tone: 'error',
      }),
  });
  // Trash pauses a public link rather than ending it (docs/share-links-design.md §3). That is worth
  // saying before the move: whoever has the link loses it now, and has it again if the session is
  // restored. A session nobody shared moves straight to Trash, with its Undo, as before.
  const requestTrash = (session: any): void => {
    const target = { id: session.id, title: session.title, projectId: session.projectMembership?.projectId };
    const shared = session.id === selectedId ? selectedShared : session.shared === true;
    if (!shared) {
      deleteMut.mutate(target);
      return;
    }
    modal.confirm({
      title: 'Move to Trash?',
      content:
        'Its public link is paused while the session is in Trash. Restoring the session turns the link back on.',
      okText: 'Move to Trash',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => deleteMut.mutate(target),
    });
  };
  // Download HTML, from the session's own menu: the whole transcript through the owner's routes
  // (lib/sessionExport), fetched only when asked — the module carries the app's stylesheet.
  const [downloadingHtml, setDownloadingHtml] = useState(false);
  const downloadHtml = async (session: any): Promise<void> => {
    if (downloadingHtml) return;
    setDownloadingHtml(true);
    try {
      const { downloadSessionHtml } = await import('../lib/sessionExport');
      await downloadSessionHtml({
        id: session.id,
        title: session.title,
        status: sessionRunStateOf(session),
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        lastTurnAt: session.lastTurnAt,
        workspace: { name: session.workspace?.name ?? null },
      });
    } catch (e) {
      message.error("Couldn't download the HTML", (e as Error).message);
    } finally {
      setDownloadingHtml(false);
    }
  };
  // Copy link: the signed-in address, for the owner's own use — never the public one (§8).
  const copySessionLink = (session: any): void => {
    void copyText(`${window.location.origin}/sessions/${encodeId(session.id)}`).then((ok) =>
      ok ? message.success('Link copied') : message.error("Couldn't copy the link"),
    );
  };
  // Permanent delete (from Trash): unlike deleteMut there's no undo — the row and all its
  // data are gone — so it's always gated behind confirmPurge's modal.
  const purgeMut = useMutation({
    mutationFn: (session: SessionToastTarget) => purgeSession(session.id),
    onSuccess: (_d, session) => {
      leaveIfOpen(session.id);
      dropFromLists(session.id);
      qc.invalidateQueries({ queryKey: ['sessions'] });
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'purge',
        headline: 'Session permanently deleted',
        tone: 'danger',
        icon: 'trash',
      });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'purge-error',
        headline: "Couldn't delete the session permanently",
        detail: e.message,
        tone: 'error',
      }),
  });
  const confirmPurge = (session: SessionToastTarget): void => {
    modal.confirm({
      title: 'Delete permanently?',
      content:
        'This session and its full transcript will be permanently deleted. This cannot be undone.',
      okText: 'Delete permanently',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: () => purgeMut.mutate(session),
    });
  };
  // Double-click the header title to rename. Optimistically patch the title into every
  // cached session list (the header reads `selected.title` off that list, not the detail
  // query) so the new name shows instantly; reconcile or roll back on settle.
  const renameMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onMutate: ({ id, title }) =>
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, title } : s)) : old,
      ),
    onError: (e: Error) => message.error("Couldn't rename the session", e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  // Pin/unpin a session to the top of the list. Optimistically flip pinnedAt in every cached
  // list (mirrors renameMut) so the row jumps immediately; reconcile on settle.
  const pinMut = useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: boolean; projectId?: string }) =>
      pin ? pinSession(id) : unpinSession(id),
    onMutate: ({ id, pin, projectId }) => {
      const patch = (old: any[] | undefined) =>
        Array.isArray(old)
          ? old.map((s) =>
              s.id === id ? { ...s, pinnedAt: pin ? new Date().toISOString() : null } : s,
            )
          : old;
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, patch);
      if (projectId) qc.setQueriesData<any[]>({ queryKey: ['project-sessions', projectId] }, patch);
    },
    onError: (e: Error, { pin }) =>
      message.error(pin ? "Couldn't pin the session" : "Couldn't unpin the session", e.message),
    onSettled: (_data, _error, { projectId }) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      if (projectId) void qc.invalidateQueries({ queryKey: ['project-sessions', projectId] });
    },
  });
  // A tapped swipe button (or a full swipe) runs the same request as the row's menu
  // action; the row settles closed either way.
  const runSwipeAction = (action: SwipeAction, s: any): void => {
    setSwipeOpen(null);
    if (action === 'complete') requestComplete(s);
    else if (action === 'restore') requestRestore(s);
    else if (action === 'pin') pinMut.mutate({ id: s.id, pin: !s.pinnedAt, projectId: s.projectMembership?.projectId });
    else if (action === 'share') setShareRowId(s.id);
    else if (action === 'move') openMove(s);
    else if (action === 'delete') requestTrash(s);
    else confirmPurge({ id: s.id, title: s.title });
  };
  // Apply the menu's complete selection in one write. Optimistically patch every list scope so the
  // checkmarks, row dots and tag grouping move immediately; the server response restores its order.
  const setTagsMut = useMutation({
    mutationFn: ({ id, tagIds }: { id: string; tagIds: string[] }) => setSessionTags(id, tagIds),
    onMutate: ({ id, tagIds }) => {
      const previousLists = qc.getQueriesData<any[]>({ queryKey: ['sessions'] });
      const previousDetail = qc.getQueryData<any>(['session', id]);
      const tags = sessionTags.filter((t) => tagIds.includes(t.id));
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, tags } : s)) : old,
      );
      qc.setQueryData<any>(['session', id], (old: any) => (old ? { ...old, tags } : old));
      return { previousLists, previousDetail };
    },
    onSuccess: (tags, { id }) => {
      qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
        Array.isArray(old) ? old.map((s) => (s.id === id ? { ...s, tags } : s)) : old,
      );
      qc.setQueryData<any>(['session', id], (old: any) => (old ? { ...old, tags } : old));
    },
    onError: (e: Error, { id }, context) => {
      context?.previousLists.forEach(([key, value]) => qc.setQueryData(key, value));
      if (context?.previousDetail !== undefined) {
        qc.setQueryData(['session', id], context.previousDetail);
      }
      message.error("Couldn't update the tags", e.message);
    },
    onSettled: (_data, _error, { id }) => {
      tagSaveInFlight.current = false;
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['session', id], exact: true });
    },
  });
  // Enable worktree isolation for a non-git workspace: flip autoInitGit so the runner `git
  // init`s the workDir on the next run (the shared-nogit nudge clears once a run isolates).
  const enableIsoMut = useMutation({
    mutationFn: (workspaceId: string) => enableWorkspaceIsolation(workspaceId),
    onSuccess: () =>
      message.success('Isolation enabled — the next run will initialize git and isolate.'),
    onError: (e: Error) => message.error("Couldn't enable worktree isolation", e.message),
  });
  const askEnableIsolation = (workspaceId: string) =>
    modal.confirm({
      title: 'Enable worktree isolation?',
      content:
        "This initializes a git repo in the workspace's working directory (a default .gitignore" +
        ' + a baseline commit of the existing files) on its next run, so concurrent sessions' +
        ' each get their own branch instead of sharing the directory.',
      okText: 'Enable',
      // Swallow a rejected enable (onError already toasts) so confirm() closes cleanly
      // instead of leaving an unhandled promise rejection.
      onOk: () => enableIsoMut.mutateAsync(workspaceId).catch(() => {}),
    });
  // Repair the machine's shared checkout when the runner reports it stuck mid-merge (which blocks
  // every session's merge there). Async like the others: the runner does it on its next heartbeat,
  // and refetching workspaces is what clears the warning, since repoHealth rides that payload.
  const repoCleanupMut = useMutation({
    mutationFn: (workspaceId: string) => cleanUpWorkspaceRepo(workspaceId),
    onSuccess: () => {
      message.success(REPO_CLEANUP_QUEUED);
      void qc.invalidateQueries({ queryKey: workspacesQuery().queryKey });
    },
    onError: (e: Error) => message.error("Couldn't clean up the checkout", e.message),
  });
  const askCleanUpRepo = (workspaceId: string, root: string) =>
    modal.confirm({
      ...repoCleanupConfirm(root),
      onOk: () => repoCleanupMut.mutateAsync(workspaceId).catch(() => {}),
    });
  // Merge this session's worktree branch into main on the runner that ran it. Async: the
  // runner merges on its next heartbeat and the outcome lands on sessionDetail.mergeStatus
  // (the status bar polls while pending). Invalidate detail so 'pending' shows immediately.
  const mergeMut = useMutation({
    mutationFn: (vars: SessionToastTarget & { target?: string; recoveryAction?: MergeRecoveryAction; previewId?: string }) =>
      mergeSessionToMain(vars.id, vars.target, vars.recoveryAction, vars.previewId),
    onSuccess: (_d, vars) => {
      qc.setQueryData<any>(['session', vars.id], (old: any) =>
        old
          ? { ...old, mergeStatus: 'pending', mergeTarget: vars.target ?? old.mergeTarget, mergeError: null }
          : old,
      );
      if (vars.recoveryAction === 'preview') {
        void qc.invalidateQueries({ queryKey: ['session', vars.id] });
        return;
      }
      const token = ++pendingOperationSeq.current;
      setPendingSessionOperations((current) => ({
        ...current,
        [vars.id]: { ...vars, token, kind: 'merge' },
      }));
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
    },
    onError: (e: Error, vars) =>
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'merge-request-error',
        headline: `Couldn't start the merge${vars.target ? ` into ${vars.target}` : ''}`,
        detail: e.message,
        tone: 'error',
      }),
  });
  const repairRecoveryMut = useMutation({
    mutationFn: (preparePr: boolean) => {
      if (!selectedId || !detailForSelected?.mergeRecovery) throw new Error('No repair context');
      return createMergeRepairSession(selectedId, preparePr);
    },
    onSuccess: (session) => {
      if (selectedId) {
        qc.setQueryData<any>(['session', selectedId], (old: any) =>
          old ? { ...old, mergeRepairSession: session } : old,
        );
        void qc.invalidateQueries({ queryKey: ['session', selectedId], exact: true });
      }
      message.sessionNotice({ sessionId: session.id, sessionTitle: session.title ?? 'Merge repair', event: 'merge-repair',
        headline: 'Repair session started', detail: 'Opening the repair session.', tone: 'info' });
      navigate(`/sessions/${encodeId(session.id)}`);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => message.error("Couldn't start the repair session", e.message),
  });
  // Resolve a merge conflict in-session: revive the session so its own workspace rebases the branch
  // onto the target that conflicted and fixes the conflicts (it has the context for its own
  // changes); the rebase bakes the resolution into the branch's commits, so the runner's rebase
  // merge then fast-forwards cleanly. resume() clears the stale mergeStatus, so the bar offers
  // "Merge to <target>" again once the workspace finishes.
  const resolveMut = useMutation({
    mutationFn: (vars: SessionToastTarget & { branch: string; target: string }) => {
      const content =
        'Rebase this branch onto the latest ' +
          vars.target +
          ' and resolve any conflicts.\n\n' +
          "You're in this session's isolated git worktree, checked out on " +
          vars.branch +
          '. Run git rebase ' +
          vars.target +
          ' — it may stop on conflicts. For each, resolve every conflict' +
          ' using your knowledge of the changes made on this branch, git add the resolved' +
          ' files, then git rebase --continue, repeating until the rebase completes. Do not' +
          ' push. Once the rebase finishes, the branch can be merged into ' +
          vars.target +
          ' cleanly from the status bar above the composer.';
      const operation = resolveConflictLogicalSendToken(resolveConflictOperationRef.current, {
        sessionId: vars.id,
        branch: vars.branch,
        target: vars.target,
        content,
      });
      resolveConflictOperationRef.current = operation;
      return resumeSession(
        vars.id,
        content,
        undefined,
        undefined,
        undefined,
        operation.clientTurnId,
      );
    },
    onSuccess: (_d, vars) => {
      resolveConflictOperationRef.current = null;
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-conflict',
        headline: 'Conflict resolution started',
        tone: 'info',
        icon: 'sync',
      });
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error, vars) =>
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-conflict-error',
        headline: "Couldn't start resolving the conflict",
        detail: e.message,
        tone: 'error',
      }),
  });
  // Hand a failed commit to the session: its own agent can see what refused the commit (a held
  // index.lock, most often), clear it and commit — what the runner will not do unasked. resume()
  // clears the settled commit error, so the bar offers Commit afresh while the agent works.
  const resolveCommitMut = useMutation({
    mutationFn: (vars: SessionToastTarget & { branch: string; why: string }) => {
      const content = resolveCommitPrompt(vars.branch, vars.why);
      const operation = logicalSendToken(resolveCommitOperationRef.current, {
        operation: 'resolve-commit',
        sessionId: vars.id,
        branch: vars.branch,
        content,
      });
      resolveCommitOperationRef.current = operation;
      return resumeSession(vars.id, content, undefined, undefined, undefined, operation.clientTurnId);
    },
    onSuccess: (_d, vars) => {
      resolveCommitOperationRef.current = null;
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-commit',
        headline: 'Handed the commit to the session',
        tone: 'info',
        icon: 'sync',
      });
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error, vars) =>
      message.sessionNotice({
        sessionId: vars.id,
        sessionTitle: vars.title,
        event: 'resolve-commit-error',
        headline: "Couldn't hand the commit to the session",
        detail: e.message,
        tone: 'error',
      }),
  });
  // Commit a live session's uncommitted worktree changes onto its branch. Like merge it runs
  // on the runner (heartbeat round-trip) and the outcome lands on commitStatus/worktreeDirty;
  // committing is safe/local so it fires directly (no confirm). Invalidate detail so 'pending'
  // shows immediately and the poll above picks up the runner's outcome.
  const commitMut = useMutation({
    mutationFn: (session: SessionToastTarget) => commitSession(session.id),
    onSuccess: (_d, session) => {
      qc.setQueryData<any>(['session', session.id], (old: any) =>
        old ? { ...old, commitStatus: 'pending', commitError: null } : old,
      );
      const token = ++pendingOperationSeq.current;
      setPendingSessionOperations((current) => ({
        ...current,
        [session.id]: { ...session, token, kind: 'commit' },
      }));
      void qc.invalidateQueries({ queryKey: ['session', session.id] });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'commit-request-error',
        headline: "Couldn't start the commit",
        detail: e.message,
        tone: 'error',
      }),
  });
  // Adopt the worktree's actual HEAD branch (after an in-worktree `git checkout -b`) as the
  // session's tracked branch, so Merge/diff act on the real work instead of a stale "In main".
  // Pure server-side re-point; invalidate detail so the bar re-derives (divergence clears).
  const adoptMut = useMutation({
    mutationFn: (session: SessionToastTarget) => adoptSessionBranch(session.id),
    onSuccess: (res, session) => {
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'adopt-branch',
        headline: `Now tracking ${res.branch}`,
        tone: 'info',
        icon: 'branch',
      });
      void qc.invalidateQueries({ queryKey: ['session', session.id] });
    },
    onError: (e: Error, session) =>
      message.sessionNotice({
        sessionId: session.id,
        sessionTitle: session.title,
        event: 'adopt-branch-error',
        headline: "Couldn't update the tracked branch",
        detail: e.message,
        tone: 'error',
      }),
  });
  // Change a LIVE session's model / mode / effort / fast mode / provider, mid-turn included.
  // Optimistically patch the cached session so the pill updates instantly; server-side the runner
  // tells the running engine, or re-spawns claude --resume with the new flag when it is a provider
  // or fast mode (or a runtime with no control channel). Revert + surface the error on failure.
  // Keyed on effectiveView to match the (view-scoped) sessions query that renders the list.
  const configMut = useMutation({
    mutationFn: (cfg: {
      model?: string;
      permissionMode?: string;
      effort?: string;
      fastMode?: boolean;
      provider?: string;
      account?: string;
    }) => updateSessionConfig(selected!.id, cfg),
    onMutate: async (cfg) => {
      await qc.cancelQueries({ queryKey: sessionsKey });
      const prev = qc.getQueryData<any[]>(sessionsKey);
      qc.setQueryData<any[]>(sessionsKey, (old) =>
        (old ?? []).map((s) => (s.id === selected!.id ? { ...s, ...cfg } : s)),
      );
      return { prev };
    },
    onError: (e: Error, cfg, ctx) => {
      if (ctx?.prev) qc.setQueryData(sessionsKey, ctx.prev);
      // Named by what was picked: a provider switch carries the model, mode and effort that follow
      // it, and a model switch its mode and effort.
      message.error(
        cfg.provider !== undefined
          ? "Couldn't switch the provider"
          : cfg.model !== undefined
            ? "Couldn't change the model"
            : cfg.permissionMode !== undefined
              ? "Couldn't change the mode"
              : cfg.effort !== undefined
                ? "Couldn't change the effort"
                : "Couldn't change the speed",
        e.message,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  // Move a session to another of its runner's accounts, or back onto Automatic (switchAccount). The
  // gauge, its popover and the menu read the session's detail, so that is re-read with the list.
  const accountMut = useMutation({
    mutationFn: ({ id, account }: { id: string; account: string }) => switchSessionAccount(id, account),
    onError: (e: Error) => {
      message.error("Couldn't switch the account", e.message);
    },
    onSettled: (_result, _error, vars) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['session', vars.id] });
    },
  });

  // Drag the divider between the session list and the conversation to resize the
  // left column. Listeners live on `document` so a fast drag that outruns the 1px
  // handle keeps tracking; body cursor/select are pinned for the drag's duration.
  const startResize = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidth;
    let latest = startW;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent): void => {
      latest = Math.min(SESSION_COL_MAX, Math.max(SESSION_COL_MIN, startW + ev.clientX - startX));
      setColWidth(latest);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
      localStorage.setItem(SESSION_COL_KEY, String(latest));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Attach images to a live/resumable session (scoped to its id) or while composing a new
  // one (uploaded unscoped, then scoped to the session the send creates). Either way the
  // runner must be online to fetch the bytes — the `+` menu still offers both items, and
  // picking into a state where this is false reports why instead of dropping the file.
  const canAttach =
    runner.online &&
    !selectedTrashed &&
    !sameSessionSendBlocked &&
    (selected ? live || resumable : composing);
  const imageUid = useRef(0);
  // Validate, then upload an attachment as a staged chip. Uploaded eagerly (not on send) so
  // the turn carries only the id and a slow upload doesn't block typing. When composing
  // there's no session yet, so it's uploaded unscoped; create scopes it to the new session.
  // An inline-image type gets a thumbnail preview and the tighter image cap; any other type
  // is a generic file (no preview, 25MB cap) that the runner drops into the worktree.
  const addImage = useCallback(
    async (file: File): Promise<void> => {
      if (!canAttach) {
        message.error('Attachments need a live session and an online runner');
        return;
      }
      const isInlineImage = ALLOWED_IMAGE_TYPES.includes(file.type);
      const cap = isInlineImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (file.size <= 0) {
        message.error(`${file.name || 'File'} is empty`);
        return;
      }
      if (file.size > cap) {
        message.error(isInlineImage ? 'Image exceeds the 5MB limit' : 'File exceeds the 25MB limit');
        return;
      }
      const uid = `att-${imageUid.current++}`;
      const previewUrl = isInlineImage ? URL.createObjectURL(file) : undefined;
      setImages((prev) => [
        ...prev,
        { uid, file, name: file.name, mime: file.type, size: file.size, previewUrl, status: 'uploading' },
      ]);
      try {
        const { id } = await uploadAttachment(file, selected?.id);
        setImages((prev) => prev.map((im) => (im.uid === uid ? { ...im, status: 'done', id } : im)));
      } catch (e) {
        // Drop the failed chip and free its preview; the toast explains why.
        setImages((prev) => prev.filter((im) => im.uid !== uid));
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        message.error(
          isInlineImage ? "Couldn't upload the image" : "Couldn't upload the file",
          (e as Error).message,
        );
      }
    },
    [canAttach, selected, message],
  );
  // Hand attachments already on the control plane back to the composer as staged chips. There is no
  // blob to make and none is wanted: the bytes are under `id`, which is all a send references, so a
  // message put back carries its files without the reader finding them a second time. A queue
  // snapshot reports id and mime only, so a file chip drawn from one shows no size and an image is
  // drawn from the stored bytes rather than a local object URL.
  const composerImagesFromRefs = (
    refs: readonly { id: string; mime?: string; mimeType?: string; name?: string }[],
  ): ComposerImage[] =>
    refs.map((ref) => ({
      uid: `att-${imageUid.current++}`,
      name: ref.name ?? 'Attachment',
      mime: ref.mime ?? ref.mimeType ?? '',
      status: 'done' as const,
      id: ref.id,
    }));
  // Appended, never replacing: put-back is explicitly user-initiated and must not discard chips
  // already staged for the message being typed. Anything already staged by id stays once.
  const stageRestored = (
    refs: readonly { id: string; mime?: string; mimeType?: string; name?: string }[] | undefined,
  ): void => {
    if (!refs?.length) return;
    setImages((prev) => {
      const held = new Set(prev.map((im) => im.id).filter(Boolean));
      return [...prev, ...composerImagesFromRefs(refs.filter((ref) => !held.has(ref.id)))];
    });
  };
  const removeImage = (uid: string): void => {
    setImages((prev) => {
      const target = prev.find((im) => im.uid === uid);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((im) => im.uid !== uid);
    });
  };
  // A send waits for every staged upload to finish (so all ids are known), and goes out
  // with whatever images are ready plus the text. Either text or an image is enough.
  const uploading = images.some((im) => im.status === 'uploading');
  const readyImages = images.filter((im) => im.status === 'done' && im.id);

  function showLocalStatus(): void {
    const planRow = shownPlanUsage ? bindingPlanUsageRow(currentPlanUsageRows(shownPlanUsage)) : undefined;
    const rows = localStatusRows({
      surface: 'Web',
      runnerName: runner.displayName || runner.name,
      runnerOnline: runner.online,
      activeSessions: runner.activeSessions,
      maxConcurrent: runner.maxConcurrent,
      sessionTitle: selected?.title ?? (selectedMissing ? 'Session not found' : null),
      sessionStatus: selectedSession
        ? statusLabel(selectedSession, selectedWatchingWord)
        : selectedMissing
          ? 'not found'
          : null,
      workspaceName: shownWorkspaceName,
      provider: shownProvider,
      model: shownModel,
      permissionMode: shownMode,
      effort: shownEffort,
      // The pill's own answer, so `/status` and the composer row cannot disagree: usable says
      // there is a lane, shown says this session is in it.
      fastMode: fastModeUsable && shownFastMode,
      contextTokens,
      contextWindow:
        shownProvider === 'opencode' && shownModel === ''
          ? undefined
          : (reportedContextWindow ??
            contextWindowFor(shownModel, runner.modelCatalog, configuredProviders, shownProvider)),
      planUsageLabel: planRow?.label,
      planUsagePercent: planRow?.percent,
    });
    pinToBottom();
    setLocalStatusCards((prev) => [
      ...prev.slice(-4),
      { id: `status-${Date.now()}-${Math.random().toString(36).slice(2)}`, rows },
    ]);
  }

  const selectedRunStatus = selected ? sessionRunStatusOf(selectedSession ?? selected) : null;
  const selectedNumTurns = Number(
    (selectedSession as { numTurns?: number } | undefined)?.numTurns
      ?? (selected as { numTurns?: number } | undefined)?.numTurns
      ?? 0,
  );
  const defaultSendIntent = defaultSessionTurnIntent({
    live: !!selected && !!live,
    status: selectedRunStatus,
    numTurns: selectedNumTurns,
  });

  const onSend = (intentOverride?: SessionTurnIntent): void => {
    const intent = intentOverride ?? defaultSendIntent;
    const c = text.trim();
    if (send.isPending) return;
    const commandName = slashCommandName(c);
    if (commandName !== null) {
      if (isLocalSlashCommand(commandName)) {
        showLocalStatus();
        setText('');
        setHistIdx(-1);
        return;
      }
      if (!replyTo && !codexComposer) {
        if (!commandName) {
          message.error('Pick a slash command before sending');
          return;
        }
        // The catalog is advisory, never a gate. It's empty on a runner that hasn't
        // reported one (pre-0.1.77, freshly enrolled, or one whose CLI slash registry is
        // still unlearned — it only fills in after a session boots), and even a populated
        // one can't see a command living in a worktree the scan skips. Rejecting the send
        // there dropped the command outright: it never reached the queue, and the user was
        // left with a toast instead of a message. An unknown name costs a pass-through at
        // most — the CLI answers "Unknown command: /x" in zero turns — so warn and send.
        const catalogKnown = slashItems.some((it) => it.type !== 'local');
        const knownRunnerCommand = slashItems.some((it) => it.type !== 'local' && it.name === commandName);
        if (catalogKnown && !knownRunnerCommand) {
          message.info(`/${commandName} isn't in this runner's catalog — sending anyway`);
        }
      }
    }
    if (sameSessionSendBlocked) {
      message.info(sameSessionSendBlockedCopy);
      return;
    }
    if (uploading) return;
    // Replying to a pending AskUserQuestion: resolve it with the text as a deny+message
    // (claude reads it as feedback and continues) instead of a fresh turn. The deny channel
    // is text-only — a blocking question can only be answered with text — so attached images
    // can't ride it; deliver them as the immediately-following turn via the normal image path
    // (send.mutate, whose onSuccess also clears the staged chips). An image-only reply still
    // needs a text resolution, hence the stand-in message.
    if (replyTo) {
      // A send-back reaches the owner-confirmation door, not the approval channel, and the door
      // refuses one carrying no note — so unlike a question reply, an image alone cannot stand in
      // for the reason. Nothing is sent and the bar stays armed.
      if (replyTo.target.kind === 'ownerConfirmation') {
        if (!c) return;
        const { taskId, requestId } = replyTo.target;
        pinToBottom();
        setReplyTo(null);
        setText('');
        setComposerRefs({});
        setHistIdx(-1);
        ownerDecision.mutate({ taskId, requestId, decision: 'SEND_BACK', note: c });
        return;
      }
      // A send-back reaches the evidence decision door, and that door refuses one carrying no note
      // — so, as with the confirmation card, an image alone cannot stand in for the reason. Nothing
      // is sent and the bar stays armed.
      if (replyTo.target.kind === 'evidenceDecision') {
        if (!c || !selectedId) return;
        const { taskId, evidenceRevision, decidingSessionId } = replyTo.target;
        pinToBottom();
        setReplyTo(null);
        setText('');
        setComposerRefs({});
        setHistIdx(-1);
        evidenceDecision.mutate({
          sessionId: selectedId,
          decidingSessionId: decidingSessionId ?? selectedId,
          taskId,
          evidenceRevision,
          note: c,
        });
        return;
      }
      // Talking about a plan before it is started reaches no door either: it is an ordinary turn at
      // an idle agent, with the facts the card is drawn from carried in front of the message
      // because nothing in the session holds them. The card that armed it is untouched: its own
      // primary action is still the other way out.
      if (replyTo.target.kind === 'planChange') {
        if (!c) return;
        pinToBottom();
        const carried = replyTo.context;
        setReplyTo(null);
        setText('');
        setComposerRefs({});
        setHistIdx(-1);
        const typed = materializeReferences(c, composerRefs);
        send.mutate({
          content: carried ? `${carried}\n\n${typed}` : typed,
          images: readyImages,
          intent,
        });
        return;
      }
      // Chatting about an exception or a blocked merge (`lib/coordinatorChat`) is the same kind of
      // ordinary turn — to the coordinator, with the card's facts in front of the sentence — and
      // reaches no door either: a rerun, a merge or a close stays the press it was on the card. No
      // door waits on a note, so an image alone goes too. The facts go as they stand at the send,
      // not at the press — the item may have been handed back, rerun or handled while the sentence
      // was typed (§4.7) — and a subject that has left the reads since goes as it read then, saying so.
      if (replyTo.target.kind === 'coordinatorChat') {
        if (!c && readyImages.length === 0) return;
        const { projectId, about } = replyTo.target;
        const live = chatSubjectIn(about, openItems.data, currentPromotion.data);
        const carried = live
          ? coordinatorChatContext(live, projectId, Date.now())
          : replyTo.context
            ? `${CHAT_FACTS_AS_ARMED}\n\n${replyTo.context}`
            : undefined;
        pinToBottom();
        setReplyTo(null);
        setText('');
        setComposerRefs({});
        setHistIdx(-1);
        const typed = c ? materializeReferences(c, composerRefs) : '';
        send.mutate({
          content: [carried, typed].filter(Boolean).join('\n\n'),
          images: readyImages,
          intent,
        });
        return;
      }
      const imgs = readyImages;
      if (!c && imgs.length === 0) return;
      pinToBottom();
      void decide(replyTo.target.id, 'deny', undefined, c || '(see attached image)');
      setReplyTo(null);
      setText('');
      setComposerRefs({});
      if (imgs.length > 0) {
        setHistIdx(-1);
        send.mutate({ content: '', images: imgs, intent });
      }
      return;
    }
    if (!c && readyImages.length === 0) return;
    pinToBottom();
    setHistIdx(-1);
    // `!cmd` runs a raw shell command on the runner (bypassing claude): on a live session,
    // as the first turn of a brand-new draft (no selection), or as the revive turn of an
    // ended-but-resumable session — the server seeds it as a shell turn and the runner runs
    // it once it claims the session (a resume --resumes claude first, so its context is back
    // before the command runs). Its output echoes to the transcript and feeds claude as
    // context on the next message. A bare `!` is a no-op; images are ignored. A terminal
    // session is capability-checked in the mutation; without resumable context it starts fresh.
    if (c.startsWith('!')) {
      // DeepSeek Harness has no shell bridge (the runner settles such a turn as a refusal), so the
      // command is kept in the composer rather than sent to fail.
      if (runtimeForProvider(shownProvider, configuredProviders) === AgentProvider.DSH) {
        message.warning('DeepSeek Harness sessions don’t run ! shell commands', 'Ask the agent to run it instead.');
        return;
      }
      const cmd = c.slice(1).trim();
      if (cmd) send.mutate({ content: cmd, images: [], shell: true, intent: 'NEXT_TURN' });
      else setText('');
      return;
    }
    send.mutate({
      content: materializeReferences(c, composerRefs),
      images: readyImages,
      intent,
    });
  };
  // Open the new-session draft for this workspace. A /sessions/<id> URL carries no
  // workspace, so resolve it from the open session (scopeWorkspaceId), then the first workspace.
  const goNew = (): void => {
    const a = scopeWorkspaceId ?? workspacesForRunner[0]?.id;
    // On a folder's page the draft is for that folder: the session it starts is filed there.
    navigateWithPaneSlide('push', () =>
      navigate(a ? `/workspaces/${encodeId(a)}/new${folderSearch}` : `/runners/${encodeId(runner.id)}`, {
        state: stampFromList(),
      }),
    );
    // No setText here: the per-target switch effect restores the saved 'new' draft, and
    // blanking would instead clobber the *outgoing* session's draft (text hasn't moved yet).
    // Drop the caret into the composer so the task can be typed straight away — both the
    // "New session" click and the ⌘N shortcut funnel through here. Deferred a tick so the
    // switch effect has swapped in the 'new' draft before focus lands.
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // ⌘/Ctrl+N opens the new-session draft — the keyboard twin of the "New session" button,
  // and the web mirror of the macOS client's ⌘N. Like ⌘D it fires even while the composer
  // is focused. Heads-up: most desktop browsers reserve ⌘N for "New Window" and won't let
  // the page override it, so preventDefault is best-effort (works in standalone/PWA).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'n' || e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      goNew();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNew]);
  // While the selected session is still loading we can't tell if it's live yet;
  // block send to avoid accidentally creating a duplicate session.
  const loadingSession = !!selectedId && !selected && !selectedMissing;
  // A live session accepts a message in any non-terminal state: RUNNING/INTERRUPTED queue
  // it, AWAITING_INPUT runs it now, and PENDING (still waiting for a slot, no claude yet)
  // queues it until the runner claims the session. A non-live (ended) session revives or
  // starts fresh. `live` is exactly "not terminal", so no per-status gate is needed here.
  const pendingSlashCommand = slashCommandName(text);
  const localSlashReady = pendingSlashCommand !== null && isLocalSlashCommand(pendingSlashCommand);
  const canSend = localSlashReady
    ? !send.isPending
    : (!!text.trim() || readyImages.length > 0) &&
      !send.isPending &&
      !uploading &&
      runner.online &&
      !selectedTrashed &&
      !sameSessionSendBlocked &&
      !selectedMissing &&
      !loadingSession;
  // The single send button morphs into a Stop while a turn is generating AND the composer
  // is empty — interrupting that turn. With content typed it stays Send, so a follow-up can
  // still be queued mid-turn. Ending the whole session isn't a button here: it's destructive
  // and the reaper recycles an idle/finished session's slot on its own.
  const showStop =
    !!selected &&
    sessionRunStatusOf(selectedSession ?? selected) === 'RUNNING' &&
    !text.trim() &&
    readyImages.length === 0 &&
    !replyTo;

  // ── `/` command, skill, and local command autocomplete ─────────────────────
  // The runner reports its on-disk slash commands/skills via heartbeat (runner.commands
  // / runner.skills). Show them as a hint menu while the cursor sits on a `/token`
  // at the start of input or right after whitespace/newline, like the Claude Code TUI;
  // picking one replaces just that token with `/<name> ` (the trailing space drops the
  // regex match, so the menu auto-hides).
  const taRef = useRef<any>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Manual composer height (px). null = autoSize auto-grow (up to maxRows); once the user
  // drags the top handle, that height wins over autoSize until they double-click to reset.
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  // Drag the top handle to set an explicit composer height. Drag up = taller; the height is
  // clamped so it can't collapse away or swallow the transcript.
  const startComposerResize = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault();
    const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
    const startY = e.clientY;
    const startH = ta?.offsetHeight ?? composerHeight ?? 120;
    const onMove = (ev: MouseEvent): void => {
      setComposerHeight(Math.min(Math.max(startH + (startY - ev.clientY), 44), 640));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [composerHeight]);
  // The resize handle only earns its keep once auto-grow has hit its maxRows cap (the box is
  // scrolling) or the user already dragged an explicit height — a short/empty box has nothing
  // worth resizing, so we hide the handle until then. Re-measure whenever the text or the
  // manual height changes (a double-click reset drops us back to auto-grow).
  const [composerCapped, setComposerCapped] = useState(false);
  useEffect(() => {
    const ta: HTMLTextAreaElement | undefined = taRef.current?.resizableTextArea?.textArea;
    if (!ta) return;
    // Measure on the next frame, after rc-textarea's autoSize pass settles this value's height.
    const id = requestAnimationFrame(() => {
      setComposerCapped(ta.scrollHeight > ta.clientHeight + 1);
    });
    return () => cancelAnimationFrame(id);
  }, [text, composerHeight]);
  // Drag-and-drop files anywhere onto the session pane (transcript + composer) — a far bigger
  // target than the composer box, matching Slack/ChatGPT. Same upload path as the picker/paste,
  // gated on canAttach. dragDepth counts enter/leave across child elements (each fires its own
  // events) so the drop hint doesn't flicker as the pointer crosses messages, the textarea, etc.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dragHasFiles = (e: ReactDragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onSessionDragEnter = (e: ReactDragEvent): void => {
    if (!canAttach || !dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onSessionDragOver = (e: ReactDragEvent): void => {
    if (!canAttach || !dragHasFiles(e)) return;
    // preventDefault marks the pane a valid drop target; without it the browser opens the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onSessionDragLeave = (): void => {
    if (!dragging) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragging(false);
    }
  };
  const onSessionDrop = (e: ReactDragEvent): void => {
    dragDepth.current = 0;
    setDragging(false);
    if (!canAttach) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  // The `+` menu opens the picker scoped to one asset kind; null (manual `/` typing) shows both.
  const [slashScope, setSlashScope] = useState<'command' | 'skill' | null>(null);
  const slashToken = getSlashToken(text);
  // Scope the `/` menu to the composer's workspace: host-level assets (no workspaceId — e.g.
  // ~/.claude or the runner's default dir) plus the assets of the workspace this session
  // runs as. A live session's workspace is fixed; a draft uses the picked workspace.
  const composerWorkspaceId = live ? selected?.workspace?.id : workspaceId;
  const slashItems = useMemo<ComposerSlashItem[]>(
    () => [
      ...LOCAL_SLASH_ITEMS,
      ...(codexComposer ? [] : [
        ...(runner.commands ?? []).map((c) => ({
          name: c.name,
          description: c.description,
          type: 'command' as const,
          provider: c.provider,
          workspaceId: c.agentId,
          builtin: c.builtin,
        })),
        ...(runner.skills ?? []).map((s) => ({
          name: s.name,
          description: s.description,
          type: 'skill' as const,
          provider: s.provider,
          workspaceId: s.agentId,
          builtin: s.builtin,
        })),
      ].filter(
        (it) =>
          slashAssetMatchesProvider(it.provider, slashProvider) &&
          (!it.workspaceId || it.workspaceId === composerWorkspaceId),
      )),
    ],
    [runner.commands, runner.skills, composerWorkspaceId, codexComposer, slashProvider],
  );
  const slashMatches = useMemo(() => {
    const items = runner.online ? slashItems : slashItems.filter((it) => it.type === 'local');
    return getSlashMatches(items, slashToken, slashScope);
  }, [slashItems, slashToken, slashScope, runner.online]);
  useEffect(() => {
    setSlashIndex(0);
    if (slashToken === null) setSlashScope(null);
  }, [slashToken]);
  const showSlash =
    slashToken !== null &&
    slashToken !== slashDismissed &&
    !selectedTrashed &&
    !selectedMissing &&
    slashMatches.length > 0;
  const slashIdx = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;
  const pickSlash = (name: string): void => {
    // Replace only the trailing `/token` ($1 preserves the start-or-whitespace before
    // it), so picking a command mid-message doesn't clobber text typed earlier.
    setText(replaceSlashToken(text, name));
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // ── `@` workspace-mention autocomplete ─────────────────────────────────────────
  // Type `@` to reference another workspace on this runner; picking one inserts
  // `@<name> ` as plain text. The in-session orchestrator reads the mention from
  // the turn (sent verbatim) and can hand work off to that workspace via its session
  // tools — so this is purely a composer convenience with no separate send path.
  // Mirrors the `/` menu above and the task-comment mention menu (TaskDetailPanel).
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const mentionToken = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1] ?? null;
  const mentionMatches = useMemo(() => {
    if (mentionToken === null) return [];
    const q = mentionToken.toLowerCase();
    return workspacesForRunner
      .filter((a) => a.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [workspacesForRunner, mentionToken]);
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionToken]);
  const showMention =
    mentionToken !== null &&
    mentionToken !== mentionDismissed &&
    !selectedTrashed &&
    !selectedMissing &&
    mentionMatches.length > 0;
  const mentionIdx = mentionMatches.length ? Math.min(mentionIndex, mentionMatches.length - 1) : 0;
  const pickMention = (name: string): void => {
    // Replace only the trailing `@token` ($1 preserves the start-or-whitespace before it),
    // so picking a workspace mid-message doesn't clobber text typed earlier.
    setText(text.replace(/(^|\s)@([^\s@]*)$/, `$1@${name} `));
    setMentionDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // ── `#` task / task-list references ────────────────────────────────────────────────────
  // Type `#` to reference a list or task; picking one inserts `#<title>` as readable text and
  // records which id that title meant. The full `[title](orbit-list:<id>)` link is materialised
  // on send (see materializeReferences) and expanded by the server at delivery — the box never
  // holds a uuid, because the chip layer that hides one cannot keep the caret aligned with it.
  const [refIndex, setRefIndex] = useState(0);
  const [refDismissed, setRefDismissed] = useState<string | null>(null);
  const refToken = referenceToken(text);
  const refListsQ = useQuery({
    queryKey: ['task-lists'],
    queryFn: () => api<Array<{ id: string; title: string }>>('/task-lists'),
    // Only once the user reaches for the menu: most drafts never contain a reference, and the
    // list index is not otherwise needed on this screen.
    enabled: refToken !== null,
    staleTime: 30_000,
  });
  const refTasksQ = useQuery({
    queryKey: ['tasks', 'ref-picker', refToken],
    queryFn: () =>
      api<{ items: Array<{ id: string; title: string }> }>(
        `/tasks/page?limit=8&counts=none&q=${encodeURIComponent(refToken ?? '')}`,
      ).then((p) => p.items),
    // A blank `#` lists lists only: every task in the deployment is not a useful first screen,
    // and the search is what makes the task half navigable at 56k rows.
    enabled: !!refToken,
    staleTime: 10_000,
  });
  const refMatches = useMemo(() => {
    if (refToken === null) return [];
    const q = refToken.toLowerCase();
    const lists = (refListsQ.data ?? [])
      .filter((l) => l.title.toLowerCase().includes(q))
      .slice(0, 5)
      .map((l) => ({ kind: 'list' as const, id: l.id, title: l.title }));
    const tasks = (refTasksQ.data ?? [])
      .slice(0, 5)
      .map((t) => ({ kind: 'task' as const, id: t.id, title: t.title }));
    return [...lists, ...tasks];
  }, [refToken, refListsQ.data, refTasksQ.data]);
  useEffect(() => {
    setRefIndex(0);
  }, [refToken]);
  const showRef =
    refToken !== null &&
    refToken !== refDismissed &&
    !selectedTrashed &&
    !selectedMissing &&
    refMatches.length > 0;
  const refIdx = refMatches.length ? Math.min(refIndex, refMatches.length - 1) : 0;
  const pickRef = (m: { kind: 'list' | 'task'; id: string; title: string }): void => {
    const next = applyReferencePick(text, m.title, { kind: m.kind, id: m.id }, composerRefs);
    setText(next.text);
    setComposerRefs(next.refs);
    setRefDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  // Open the autocomplete from the `+` menu scoped to one asset kind: drop a `/` (prefixed
  // with a space when mid-message) so slashToken matches and the menu pops.
  const insertSlash = (scope: 'command' | 'skill'): void => {
    setSlashScope(scope);
    setText(openSlash);
    setSlashDismissed(null);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The draft is a `!cmd` shell command, not a message: onSend routes it raw to the runner,
  // bypassing the workspace. Mirrors that branch's condition exactly (it reads the trimmed text,
  // and a reply-to-question draft resolves an approval instead), so the composer only turns
  // red when the send really would be a shell turn.
  const shellMode = !replyTo && text.trim().startsWith('!');
  // The `+` menu "Shell" entry: prefix the draft with `!` so onSend routes it as a raw
  // shell command (run on the runner, bypassing claude). The user types the command after.
  const insertShell = (): void => {
    setText((t) => (t.startsWith('!') ? t : `!${t}`));
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The exact inverse: drop the `!` so the draft goes back to being a message for the workspace.
  // This is what the `❯` replacing the `+` does in shell mode — a mode you can enter needs a
  // way out that isn't "select the character and delete it". Leading whitespace goes too,
  // since shellMode reads the trimmed text (`  !ls` is shell mode just as much as `!ls`).
  const exitShell = (): void => {
    setText((t) => t.replace(/^\s*!/, ''));
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // "Chat about this" on a question card hands the reply off to the main composer: show the
  // reply-context chip and focus the box. The send itself is rerouted to a deny in onSend.
  const startChatReply = (id: string, question: string): void => {
    setReplyTo({
      target: { kind: 'approval', id },
      banner: `Replying to Claude’s question${question ? `: ${question}` : ''}`,
      placeholder: 'Reply to Claude’s question…',
    });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // Declining one of Orbit's own asks — same channel as a chat reply, because a decline IS a
  // deny+message; what differs is that the sentence is the point rather than an alternative to
  // picking an option. See `decliningPrefix`.
  const startDeclineReply = (id: string, toolName: string, subject: string): void => {
    setReplyTo({
      target: { kind: 'approval', id },
      banner: decliningPrefix(toolName) + subject,
      placeholder: DECLINE_PLACEHOLDER,
    });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The confirmation card's send-back: the next send carries the typed text to the
  // owner-confirmation door as the SEND_BACK's reason. The card stays until then, with its own
  // confirm still live — pressing that is the other way out.
  const startOwnerSendBack = (waiting: OwnerConfirmationWaiting, title: string): void => {
    if (!selectedTaskId) return;
    setReplyTo({
      target: { kind: 'ownerConfirmation', taskId: selectedTaskId, requestId: waiting.requestId },
      banner: OWNER_SENDING_BACK_PREFIX + title,
      placeholder: OWNER_SEND_BACK_LABEL,
    });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The evidence card's "Chat about this": the next send carries the typed text to the evidence
  // decision door as the SEND_BACK's note — the reason the next version of the evidence has to
  // answer, which is the only thing the door's refusal will accept. The card stays until then, with
  // its own confirm still live — pressing that is the other way out.
  const startEvidenceSendBack = (row: PendingDecisionRow): void => {
    setReplyTo({
      target: {
        kind: 'evidenceDecision',
        taskId: row.taskId,
        evidenceRevision: row.evidenceRevision,
        decidingSessionId: row.ownerCard?.decidingSessionId ?? null,
      },
      banner: DECISION_SENDING_BACK_PREFIX + row.title,
      placeholder: DECISION_SEND_BACK_LABEL,
    });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The settlement card's "Chat about this": the next send is an ordinary turn saying what should
  // change about the plan, with the plan itself carried in front of it. Unlike the three above it
  // answers nothing — the agent has finished writing the criteria and is waiting — so no door is
  // named here. The card stays until then, with its own Start the project still live.
  const startPlanChangeChat = (plan: SettlementPlanChat): void => {
    setReplyTo({
      target: { kind: 'planChange', projectId: plan.projectId, criteriaDigest: plan.criteriaDigest },
      banner: ACCEPTANCE_PLAN_CHANGE_PREFIX + plan.projectTitle,
      // What the composer asks for follows the card that armed it: the start card's "before it
      // starts", the change card's "about these".
      placeholder: acceptancePlanChangePlaceholder(plan.question),
      context: acceptancePlanChangeContext(plan),
    });
    setTimeout(() => taRef.current?.focus(), 0);
  };
  // The project settlement card's "Ask the coordinator to handle it": the card's own facts — the
  // blocked criteria, what each is waiting on and what would clear them — go out as one ordinary
  // turn. Ordinary because nothing is waiting on an answer: the card explains a projection, and the
  // work that would clear it is this agent's. The facts ARE the message, so unlike the armed
  // replies above there is nothing to type first; the composer stays free for anything they leave
  // out. The card stays where it is, with its own Confirm still live.
  const delegateProjectSettlement = (talk: { facts: string }): void => {
    if (send.isPending) return;
    send.mutate({ content: talk.facts, images: [], intent: defaultSendIntent });
  };
  // A LIVE session's pills show its stored choice (editable any time the runner is
  // online — see configEditable); otherwise they're editable and reflect local state.
  const selectedWorkspace = workspacesForRunner.find((a) => a.id === selected?.workspace?.id);
  const effectiveModel = effectiveSessionModel(
    shownProvider,
    selected?.model,
    detailForSelected?.workspace?.model ?? selectedWorkspace?.model,
    runner.modelCatalog,
    configuredProviders,
    runner.runtimeDefaultModels,
  );
  const effectiveEffort =
    selected?.effort ?? detailForSelected?.workspace?.effort ?? selectedWorkspace?.effort ?? '';
  // No workspace or account fallback beside it, unlike effort: fast mode is per-session, so the
  // only thing that can be inheriting here is nothing.
  const effectiveFastMode: boolean = selected?.fastMode === true;
  const shownModel: string = live ? effectiveModel : model;
  const catalogModelOptions = shownProviderCapabilitiesResolved
    ? modelOptionsForProvider(shownProvider, runner.modelCatalog, configuredProviders)
    : [];
  // Runtime configuration can name a valid model that is not in the reported catalog yet. Keep
  // that effective default/selectable session value visible in the picker instead of rendering a
  // value the user cannot return to after trying another model.
  const shownModelOptions = catalogModelOptions.some((option) => option.value === shownModel)
    ? catalogModelOptions
    : [
        {
          value: shownModel,
          label:
            !shownProviderCapabilitiesResolved && !selected ? 'Runtime default' : shownModel,
        },
        ...catalogModelOptions,
      ];
  // A session on an account pool spends one account at a time, so the status bar names that
  // account and shows its quota — not the pool's name, which says nothing about whose quota it is.
  // On a draft that is the account the claim will pick. On a session it is the one the detail row
  // recorded (the pick, until its first claim), and nobody until that row is in: a session still
  // loading must not borrow the draft's answer.
  const shownPool = accountPools.find((pool) => pool.slug === shownProvider) ?? null;
  // A shared pool's session records the key its claim chose, an account pool's the account.
  const shownPoolMemberId = shownPool?.shared
    ? detailForSelected?.poolKeyId
    : detailForSelected?.poolMemberProviderId;
  // A login pool's session records the ChatGPT account it runs on (`poolCodexLogin`), and names that —
  // not the pool's `next` member, which is the answer for a session starting now: with the pool's
  // oldest account spent there is no next, while the session runs on that very account.
  const shownPoolAccount =
    shownPool && (!selectedId || detailForSelected)
      ? isLoginPool(shownPool) && selectedId && detailForSelected?.poolCodexLogin
        ? poolSessionLoginMember(shownPool, detailForSelected.poolCodexLogin)
        : sessionPoolAccount(shownPool, selectedId ? shownPoolMemberId : null)
      : null;
  // Which of the runner's accounts a built-in Codex or Claude session spends — the draft's pick, or the
  // one picked for the session, else its workspace's — and Default for an id this runner does not
  // report, as dispatch resolves it (providers/account.ts accountOnRunner).
  const accountOnThisRunner = (engine: AccountEngine, wanted: string | null | undefined): string =>
    wanted && accountsOf(runner, engine).some((account) => account.id === wanted) ? wanted : 'default';
  // Automatic is on offer for an engine where the workspace leaves its account to Orbit: it picked none,
  // and its env selects no other config directory and no key of its own — with two accounts or more
  // to choose between. A new session there starts on the runner's account whose quota resets soonest:
  // the choice the server makes when it creates the session (automaticAccount), asked of the same numbers.
  const automaticOfferedOn = (
    engine: AccountEngine,
    workspace: { env?: Record<string, string> | null; codexAccount?: string | null; claudeAccount?: string | null } | null | undefined,
  ): boolean =>
    !(engine === 'claude' ? workspace?.claudeAccount : workspace?.codexAccount) &&
    accountsOf(runner, engine).length >= 2 &&
    accountOfEnv(engine, workspace?.env ?? null, accountsOf(runner, engine)) === 'default';
  const codexAccountsHere = accountsOf(runner, 'codex');
  const codexAutoOffered = automaticOfferedOn('codex', pickedWorkspace);
  const claudeAutoOffered = automaticOfferedOn('claude', pickedWorkspace);
  const codexAutoAccount = codexAutoOffered ? accountToStartOn('codex', codexAccountsHere, runner.planUsage, new Date()) : null;
  const claudeAutoAccount = claudeAutoOffered
    ? accountToStartOn('claude', accountsOf(runner, 'claude'), runner.planUsage, new Date())
    : null;
  // Where an ended session's held switch onto `engine` resumes, as the server decides it
  // (accountOnProviderSwitch): the account it names; else, unless the session is pinned there,
  // Automatic's pick; else where it already was.
  const pendingEngineAccount = (engine: AccountEngine): string | null | undefined => {
    if (pendingResumeAccount && pendingResumeAccount !== AUTOMATIC_ACCOUNT) return pendingResumeAccount;
    const own = engine === 'claude' ? detailForSelected?.claudeAccount : detailForSelected?.codexAccount;
    const pinned = engine === 'claude' ? detailForSelected?.claudeAccountPinned : detailForSelected?.codexAccountPinned;
    if (pinned && pendingResumeAccount !== AUTOMATIC_ACCOUNT) return own;
    const workspace = workspacesForRunner.find((w) => w.id === selected?.workspace?.id);
    return automaticOfferedOn(engine, workspace)
      ? accountToStartOn(engine, accountsOf(runner, engine), runner.planUsage, new Date())
      : (own ?? (engine === 'claude' ? detailForSelected?.workspace?.claudeAccount : detailForSelected?.workspace?.codexAccount));
  };
  const shownCodexAccount = accountOnThisRunner(
    'codex',
    selectedId
      ? pendingResumeProvider === 'codex'
        ? pendingEngineAccount('codex')
        : (detailForSelected?.codexAccount ?? detailForSelected?.workspace?.codexAccount)
      : (draftCodexAccount ?? pickedWorkspace?.codexAccount ?? codexAutoAccount),
  );
  const shownClaudeAccount = accountOnThisRunner(
    'claude',
    selectedId
      ? pendingResumeProvider === 'claude'
        ? pendingEngineAccount('claude')
        : (detailForSelected?.claudeAccount ?? detailForSelected?.workspace?.claudeAccount)
      : (draftClaudeAccount ?? pickedWorkspace?.claudeAccount ?? claudeAutoAccount),
  );
  const shownAccount =
    shownProvider === 'codex' ? shownCodexAccount : shownProvider === 'claude' ? shownClaudeAccount : 'default';
  // The engine whose account the composer names — built-in Codex or Claude, not an account pool — and the
  // account it names in the quota gauge's popover, once the runner has more than one to tell apart.
  const shownAccountEngine: AccountEngine | null =
    !shownPool && (shownProvider === 'codex' || shownProvider === 'claude') ? shownProvider : null;
  const shownAccountsHere = shownAccountEngine ? accountsOf(runner, shownAccountEngine) : [];
  const shownAccountRow =
    shownAccountsHere.length >= 2
      ? (shownAccountsHere.find((account) => account.id === shownAccount) ??
        // An account the runner does not report runs on Default — under whatever Default is called.
        shownAccountsHere.find((account) => account.id === 'default') ?? { id: 'default', name: undefined })
      : null;
  const shownAccountLabel = shownAccountRow ? accountNameOf(shownAccountRow) : null;
  const shownPlanUsage = shownPool
    ? (shownPoolAccount?.member.planUsage ?? null)
    : (shownProvider === 'codex' || shownProvider === 'claude') && shownAccount !== 'default'
      ? accountPlanUsage(runner.planUsage, shownProvider, shownAccount)
      : sessionPlanUsage(shownProvider, runner.planUsage, configuredProviders);
  // Where this session could move without changing CLI. Offered on the two routes that actually
  // carry a provider: a live session's config PATCH, and the resume that revives an ended one. A
  // draft picks in the hero above instead (which offers every runtime, not one), and a terminal
  // session that can't be resumed would start a NEW session on send, where the workspace decides. A
  // single entry means there is nowhere to go, and the pill stays out of the composer entirely —
  // the common case, one Claude sign-in and no configured providers.
  const providerSwitchChoices = useMemo(
    () =>
      live || resumable
        ? sameRuntimeChoices(
            shownProvider,
            providerChoicesForRunner,
            configuredProviders,
            runner.modelCatalog,
            runner.runtimeDefaultModels,
            runner.antigravity,
          )
        : [],
    [
      live,
      resumable,
      shownProvider,
      providerChoicesForRunner,
      configuredProviders,
      runner.modelCatalog,
      runner.runtimeDefaultModels,
      runner.antigravity,
    ],
  );
  const { tokens: contextTokens, window: reportedContextWindow } = lastContextReading(events);
  // Remedy + retry for a sign-in failure card in the transcript. Retry is offered only when
  // there's actually a message to re-send and the session can take one — a trashed/missing
  // session would just throw out of the send mutation.
  // What a retry re-sends: the words, and the ids of the files that went out with them. Read as
  // one, off one event — the attachments belong to that message, and a second walk back through the
  // transcript could stop at a different one.
  // Memoized: it builds a fresh object, and the two cards below hold it in a dependency list that
  // exists to keep them from being rebuilt on every render.
  const retry = useMemo(
    () => lastTypedUserMessage(events, detailForSelected?.prompt, selected?.numTurns),
    [events, detailForSelected?.prompt, selected?.numTurns],
  );
  const retryText = retry.text;
  // …and the server's answer, for the sessions the line above cannot answer for. It is fetched
  // only when a card says it needs it (AutoRetryHelp.onNeedRetryText): the events here are this
  // page's newest 200, which hold a conversation's last message and not a run's — that one is at
  // seq 1, thousands of tool events back. Asked per session, so switching away drops the ask.
  //
  // Words only: `retry.attachmentIds` are read off the bubble this page holds, and a page holding
  // no bubble has no files to name — so the fallback re-sends the message's text and nothing else.
  const [retryMessageAskedFor, setRetryMessageAskedFor] = useState<string | null>(null);
  const serverRetry = useQuery({
    queryKey: ['session', selectedId, 'retry-message'],
    queryFn: () => getSessionRetryMessage(selectedId!),
    enabled: !!selectedId && retryMessageAskedFor === selectedId,
  }).data;
  const serverRetryText = serverRetry?.text ?? '';
  const autoRetryText = retryText || serverRetryText;
  // Whose words those are. Another Orbit session's are not the reader's to send again: through
  // `send` they would go out in the owner's name, signed by nobody. So the Retry asks the server to
  // re-send them as the automatic retry would — that session's, with the request they were, charged
  // to nobody's hourly limit (docs/session-request-reply-contract.md §2.1). Read off the same bubble
  // as the words, or off the server's answer when the window held none.
  const retryFromSession = retryText ? retry.sessionMessage : serverRetry?.sessionMessage;
  const resendFromSession = useMutation({
    // With whatever the composer has picked — pressing Retry after choosing a provider means
    // "re-send this there", and the server moves the session as it would on a send.
    mutationFn: (sessionId: string) =>
      resendSessionRetryMessage(sessionId, {
        ...(pendingResumeProvider ? { provider: pendingResumeProvider } : {}),
        ...(pendingResumeAccount ? { account: pendingResumeAccount } : {}),
      }),
    onSuccess: (_answer, sessionId) => qc.invalidateQueries({ queryKey: ['session', sessionId] }),
    // Said, not returned: an error toast stays until it is dismissed, and React Query waits on what
    // `onError` hands back before the press stops being in flight. Returned, a press that failed — or
    // whose answer was lost — held Retry disabled for as long as the toast stood, and pressing again
    // is exactly how such a press is answered (§8 criterion 22): the server's key is the failure's.
    onError: (e: Error) => void message.error("Couldn't re-send the message", e.message),
  });
  const resendFromSessionMutate = resendFromSession.mutate;
  const sendMutate = send.mutate;
  // §2.1, §8 criterion 19: a Retry already in flight is not offered a second time. The server is
  // idempotent on the failed message, so a second click could not queue a second turn for one — but
  // the owner's own message goes through the send door, where a second call would be a second turn,
  // and either way the button must not promise an attempt it is not making. Both cards draw it
  // disabled from this, and both handlers refuse a re-entry that reaches them anyway.
  const retryInFlight = send.isPending || resendFromSession.isPending;
  const geminiProviders = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
    enabled: shownProvider === 'antigravity' || runtimeForProvider(shownProvider, configuredProviders) === AgentProvider.DSH,
  });
  // A Harness session's key is its own provider row; that row's page is where the key is fixed.
  const dshProviderRow = geminiProviders.data?.find((p) => p.slug === shownProvider && p.runtime === AgentProvider.DSH);
  const geminiProvider = geminiProviders.data?.find((p) => p.presetSlug === 'gemini' && p.runtime === 'antigravity');
  const geminiChoice = providerSwitchChoices.find((c) =>
    c.kind === 'byok' && configuredProviders.some((p) => p.slug === c.slug && p.presetSlug === 'gemini' && p.runtime === 'antigravity'),
  );
  const installAntigravity = useMutation({
    mutationFn: () => api(`/runners/${encodeId(runner.id)}/install`, { method: 'POST', body: { engine: 'antigravity' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => void message.error("Couldn't install Antigravity CLI", e.message),
  });
  const installDsh = useMutation({
    mutationFn: () => api(`/runners/${encodeId(runner.id)}/install`, { method: 'POST', body: { engine: 'dsh' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
    onError: (e: Error) => void message.error("Couldn't install DeepSeek Harness", e.message),
  });
  // Hand an undelivered message back to the composer, so a message the engine never received can
  // be re-sent without being retyped out of a bubble. Explicitly user-initiated, so unlike the
  // interrupt/withdraw fold-backs (which fire on their own and therefore only write into an empty
  // composer) it never discards a draft: whatever is being typed keeps its place above it.
  const restoreUndelivered = useMemo(
    () =>
      selectedTrashed || selectedMissing
        ? null
        : (
            text: string,
            attachments?: readonly { id: string; mime?: string; mimeType?: string; name?: string }[],
          ) => {
            const body = text.trim();
            if (!body) return;
            setText((draft) => (draft.trim() ? `${draft}\n\n${body}` : body));
            stageRestored(attachments);
            setTimeout(() => taRef.current?.focus(), 0);
          },
    [selectedTrashed, selectedMissing],
  );
  // Take back a message whose delivery settled undelivered. Nothing read it, so this bubble is
  // the only copy of what was typed: hand it back the way the transcript's own undelivered card
  // does (appended, never overwriting a draft), then discard the row so the pane stops carrying a
  // red bubble under a conversation that has long since moved past it.
  const takeBackUndelivered = async (turn: QueuedTurn): Promise<void> => {
    if (!selectedId || !restoreUndelivered) return;
    restoreUndelivered(turn.content, turn.attachments);
    setQueued((q) => q.filter((x) => x.turnId !== turn.turnId));
    try {
      await cancelQueuedTurn(selectedId, turn.turnId);
    } catch (e) {
      message.error("Couldn't discard the message", e instanceof Error ? e.message : undefined);
    }
  };
  // The same retry, plus the pending auto-retry, for the quota / provider-error card. Disarming
  // is a plain fire-and-forget: the detail query refetches on settle, and the card's own
  // countdown is driven by the value it reads back.
  const autoRetryHelp: AutoRetryHelp = useMemo(
    () => ({
      provider: shownProvider,
      runnerName: runner.name,
      retryAt: detailForSelected?.retryAt ?? null,
      attempts: detailForSelected?.retryAttempts ?? 0,
      onRetry:
        autoRetryText && !selectedTrashed && !selectedMissing
          ? retryFromSession && selectedId
            ? () => {
                if (retryInFlight) return;
                resendFromSessionMutate(selectedId);
              }
            : () => {
                if (retryInFlight) return;
                sendMutate({
                  content: autoRetryText,
                  images: [],
                  attachmentIds: retry.attachmentIds,
                  source: 'autoRetry',
                });
              }
          : undefined,
      retryDisabled: retryInFlight,
      retryText: autoRetryText,
      // The card's own Retry goes through `send`, so its refusal arrives in the same handler as a
      // typed message's. Handed to the card rather than left to the toast: it is the card's offer
      // to re-send that has stopped being true, so the card is where that has to show.
      // …but never a QUESTION: a confirmation is about the provider the reader just picked in the
      // composer, and it is answered there, where the only controls that can answer it live.
      takenOver:
        runConflict?.vars.source === 'autoRetry' && runConflict.conflict.kind !== 'CONFIRM_SWITCH'
          ? runConflict.conflict
          : null,
      onNeedRetryText: selectedId ? () => setRetryMessageAskedFor(selectedId) : undefined,
      onCancelAuto: selected?.id
        ? () => {
            cancelAutoRetry(selected.id)
              .then(() => qc.invalidateQueries({ queryKey: ['session', selected.id] }))
              .catch((e: Error) => message.error("Couldn't turn off auto-retry", e.message));
          }
        : undefined,
      onArmAuto: selected?.id
        ? (at: Date) => {
            armAutoRetry(selected.id, at)
              .then(() => qc.invalidateQueries({ queryKey: ['session', selected.id] }))
              .catch((e: Error) => message.error("Couldn't turn on auto-retry", e.message));
          }
        : undefined,
    }),
    [
      shownProvider,
      runner.name,
      detailForSelected?.retryAt,
      detailForSelected?.retryAttempts,
      autoRetryText,
      retryInFlight,
      retryFromSession,
      runConflict?.conflict,
      selectedTrashed,
      selectedMissing,
      sendMutate,
      resendFromSessionMutate,
      selected?.id,
      selectedId,
      qc,
    ],
  );
  const shownMode: string = live
    ? (PERMISSION_TO_MODE[
        shownProviderCapabilitiesResolved
          ? clampPermissionModeForModel(
              effectivePermissionMode,
              effectiveModel,
              shownProvider,
              configuredProviders,
              runner.modelCatalog,
            )
          : effectivePermissionMode
      ] ?? 'Default')
    : mode;
  const shownEffort: string = normalizeEffortForProvider(
    shownProvider,
    live ? effectiveEffort : effort,
    shownModel,
    runner.modelCatalog,
    configuredProviders,
  );
  const shownEffortOptions = effortOptionsForProvider(
    shownProvider,
    shownModel,
    runner.modelCatalog,
    configuredProviders,
  );
  // Whether this session has a fast lane to offer at all — Claude's `/fast` on the models that
  // carry it, Codex's "Fast" service tier on a model whose row in this runner's catalogue
  // advertises it. The runtime, never the slug: a configured (BYOK) identity borrows one.
  // Unresolved means no, which is the safe direction: a pill that appears and then vanishes is
  // worse than one that appears a moment late, and this is the same fact the server polices at
  // dispatch.
  const fastModeUsable =
    shownProviderCapabilitiesResolved &&
    fastModeAvailable(
      runtimeForProvider(shownProvider, configuredProviders),
      shownModel,
      runner.modelCatalog,
    );
  const shownFastMode: boolean = live ? effectiveFastMode : fastMode;
  // What a permission mode ACTUALLY means on the engine that will run it. Derived with the same
  // shared table the server stamps onto the session payload, so the picker cannot drift from it.
  //
  // Only for built-in engines: a configured (BYOK) slug borrows a runtime this screen cannot name,
  // and telling someone "you will be asked" for a session that might be running on Codex is
  // exactly the false assurance this is here to remove. Unknown => say nothing.
  //
  // DeepSeek Harness is the exception: a configured Harness key can only run on Harness (its runtime
  // can't change, providers.service), so its slug names the runtime as surely as a built-in does.
  const shownRuntime = runtimeForProvider(shownProvider, configuredProviders);
  const shownProviderIsBuiltin =
    Object.values(AgentProvider).some((p) => p === shownProvider) || shownRuntime === AgentProvider.DSH;
  const permissionSemanticsFor = useCallback(
    (label: string) =>
      shownProviderIsBuiltin
        ? derivePermissionSemantics(
            shownRuntime,
            MODE_TO_PERMISSION[label],
            shownModel,
            runner.runsAsRoot,
            runner.modelCatalog,
          )
        : undefined,
    [shownRuntime, shownProviderIsBuiltin, shownModel, runner.runsAsRoot, runner.modelCatalog],
  );
  // Model, Mode, Effort & Provider can be changed any time on a live session (the runner must be
  // online to act on it), and none of them aborts the running turn. When the change lands is the
  // server's call (SessionsService.updateConfig): model, permission mode and effort reach a
  // resident Claude Code over its control channel, and everything else waits for the re-spawn the
  // inbox defers to the end of the turn.
  // When not live they're freely editable (pre-session config).
  // Workspace stays fixed once the session exists (it's never re-assigned on resume).
  const configEditable = selectedTrashed || selectedMissing ? false : live ? runner.online : true;
  // An existing session's workspace is fixed (live or recycled/terminal); only a brand-new
  // compose draft reflects the local pick.
  const shownWorkspaceId: string | undefined = selected ? (selected.workspace?.id ?? undefined) : workspaceId;
  // The workspace can't be switched once the session exists (live or terminal), nor when the
  // view is locked to one workspace. In those cases the Select is dropped from the controls row
  // entirely — the workspace is already named in the header and the sidebar.
  const workspaceReadOnly = !!selected || !!lockedWorkspaceId;
  const shownWorkspaceName =
    workspacesForRunner.find((a) => a.id === shownWorkspaceId)?.name ??
    selected?.workspace?.name ??
    lockedWorkspace?.name;
  const composerDisabled = selectedTrashed || selectedMissing;
  // Switching session leaves whatever history recall was in progress; reset the cursor
  // so the next Up starts fresh from the (per-session) history.
  useEffect(() => {
    setHistIdx(-1);
    setHeaderMenuOpen(false);
  }, [selectedId]);
  // Title shown above the session list (and in the draft header). /sessions/<id>
  // has no workspace in the URL, so fall back to the open session's workspace, then runner.
  const headWorkspaceName =
    lockedWorkspace?.name ?? selected?.workspace?.name ?? runner.displayName ?? runner.name;

  // ── Folders (docs/session-folders-move-design.md §3, §7) ──
  // In and out of a folder's page is a change of the `folder` param on whichever route the console
  // is at, so the conversation on the right stays put. On a phone it slides like opening a session.
  const setFolderParam = (folderId: string | null, replace = false): void => {
    navigateWithPaneSlide(
      folderId ? 'push' : 'pop',
      () =>
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            if (folderId) next.set('folder', encodeId(folderId));
            else next.delete('folder');
            return next;
          },
          { replace },
        ),
      { swapsPane: false },
    );
  };
  const enterFolder = (folder: SessionFolder): void => {
    setSwipeOpen(null);
    setFolderEdit(null);
    setFolderParam(folder.id);
  };
  const leaveFolder = (replace = false): void => {
    setFolderEdit(null);
    setFolderParam(null, replace);
  };
  const enterProjectSessions = (projectId: string): void => {
    setSwipeOpen(null);
    setMenuOpenId(null);
    navigateWithPaneSlide('push', () => setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('project', encodeId(projectId));
      if (effectiveView === 'completed') next.set('view', 'completed');
      else next.delete('view');
      return next;
    }), { swapsPane: false });
  };
  const leaveProjectSessions = (): void => {
    setView(effectiveView);
    navigateWithPaneSlide('pop', () => setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('project');
      next.delete('view');
      return next;
    }), { swapsPane: false });
  };
  const startNewFolder = (): void => setFolderEdit({ id: null, draft: '', error: null, saving: false });
  // New Folder… and Rename… save on Return (or when the field is left with a name in it); an empty
  // or unchanged name just closes the field. A name the workspace already has is said under it.
  const saveFolderEdit = async (): Promise<void> => {
    const edit = folderEditRef.current;
    if (!edit || folderSaving.current) return;
    const name = folderNameDraft(edit.draft);
    const current = edit.id ? workspaceFolders.find((f) => f.id === edit.id) : null;
    if (!name || (current && current.name === name) || !scopeWorkspaceId) {
      setFolderEdit(null);
      return;
    }
    folderSaving.current = true;
    setFolderEdit({ ...edit, saving: true, error: null });
    try {
      const saved = edit.id
        ? await renameSessionFolder(edit.id, name)
        : await createSessionFolder({ workspaceId: scopeWorkspaceId, name });
      qc.setQueryData<SessionFolder[]>(['session-folders'], (old) =>
        old ? (edit.id ? old.map((f) => (f.id === saved.id ? saved : f)) : [...old, saved]) : old,
      );
      void qc.invalidateQueries({ queryKey: ['session-folders'] });
      setFolderEdit(null);
    } catch (error) {
      setFolderEdit({
        ...edit,
        saving: false,
        error: folderNameFailure(error, name, headWorkspaceName, edit.id ? 'renamed' : 'created'),
      });
    } finally {
      folderSaving.current = false;
    }
  };
  const folderEditKeys = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void saveFolderEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setFolderEdit(null);
    }
  };
  // Delete Folder…: only the folder goes. Its sessions are back in the list, none of them deleted.
  const confirmDeleteFolder = (folder: SessionFolder): void => {
    modal.confirm({
      title: FOLDER_COPY.deleteTitle(folder.name),
      content: FOLDER_COPY.deleteMessage,
      okText: FOLDER_COPY.deleteConfirm,
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await deleteSessionFolder(folder.id);
        } catch (error) {
          message.error(folderDeleteFailure(error));
          return;
        }
        qc.setQueryData<SessionFolder[]>(['session-folders'], (old) => old?.filter((f) => f.id !== folder.id));
        qc.setQueriesData<any[]>({ queryKey: ['sessions'] }, (old) =>
          Array.isArray(old) ? old.map((s) => (s.folderId === folder.id ? { ...s, folderId: null } : s)) : old,
        );
        void qc.invalidateQueries({ queryKey: ['session-folders'] });
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        if (openFolder?.id === folder.id) leaveFolder(true);
      },
    });
  };
  // A folder's two management entries — its row's ⋯ and its page's ⋯ offer the same pair.
  const folderMenuItems = (folder: SessionFolder): MenuProps['items'] => [
    {
      key: 'rename',
      icon: <EditOutlined />,
      label: FOLDER_COPY.rename,
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        setFolderMenuOpenId(null);
        setFolderEdit({ id: folder.id, draft: folder.name, error: null, saving: false });
      },
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: FOLDER_COPY.delete,
      danger: true,
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        setFolderMenuOpenId(null);
        confirmDeleteFolder(folder);
      },
    },
  ];
  // Move… from a row, the open conversation's ⋯ or a swipe: the row as the list has it, so the
  // dialog ticks the folder the list shows the session in.
  const openMove = (s: any): void => {
    setSwipeOpen(null);
    setMenuOpenId(null);
    setHeaderMenuOpen(false);
    setMoveTarget({ id: s.id, title: s.title, folderId: s.folderId ?? null, workspace: s.workspace,
      projectId: s.projectMembership?.projectId });
  };
  // A folder row: the folder, who in it waits on you, how many sessions it holds. Activity sits on
  // the folder itself as on the sidebar's Workspace rows: a still dot while a session runs, a
  // breathing one while only a background job does. Its ⋯ takes the chevron's place on hover.
  const folderRowView = (row: SessionFolderRow): ReactNode => {
    const enter = (): void => enterFolder(row.folder);
    const waiting = `${row.needsYou} ${row.needsYou === 1 ? 'session needs' : 'sessions need'} your reply`;
    return (
      <div
        key={row.folder.id}
        className={`session-folder-row${folderMenuOpenId === row.folder.id ? ' menu-open' : ''}`}
        role="button"
        tabIndex={0}
        onClick={enter}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          enter();
        }}
      >
        <span className="session-icon session-folder-icon">
          <FolderOutlined />
          {row.running ? (
            <span className="session-folder-activity" title="Running" />
          ) : row.jobs ? (
            <span className="session-folder-activity jobs" title="Background job running" />
          ) : null}
        </span>
        <span className="session-folder-name">{row.folder.name}</span>
        {row.needsYou > 0 && (
          <span className="session-folder-needs" title={waiting} aria-label={waiting}>
            {row.needsYou}
          </span>
        )}
        <span className="session-folder-count">{row.sessionCount}</span>
        <span className="session-folder-end">
          <RightOutlined className="session-folder-chev" />
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            open={folderMenuOpenId === row.folder.id}
            onOpenChange={(open) => setFolderMenuOpenId(open ? row.folder.id : null)}
            menu={{ items: folderMenuItems(row.folder) }}
          >
            <span
              className="session-kebab session-folder-more"
              role="button"
              aria-label={FOLDER_COPY.more}
              title={FOLDER_COPY.more}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreOutlined />
            </span>
          </Dropdown>
        </span>
      </div>
    );
  };
  // New Folder…'s field (id null) or Rename…'s, in the folder row's place.
  const folderEditRow = (id: string | null): ReactNode =>
    folderEdit && (
      <div key={id ?? 'new-folder'} className="session-folder-row editing">
        <span className="session-icon session-folder-icon">
          <FolderOutlined />
        </span>
        <span className="session-folder-edit">
          <input
            className={`folder-name-input${folderEdit.error ? ' error' : ''}`}
            autoFocus
            maxLength={60}
            placeholder={FOLDER_COPY.namePlaceholder}
            aria-label={id ? 'Folder name' : 'New folder name'}
            value={folderEdit.draft}
            readOnly={folderEdit.saving}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setFolderEdit({ ...folderEdit, draft: e.target.value, error: null })}
            onKeyDown={folderEditKeys}
            onBlur={() => void saveFolderEdit()}
          />
          <span className={folderEdit.error ? 'session-folder-error' : 'session-folder-hint'}>
            {folderEdit.error ?? FOLDER_COPY.editHint}
          </span>
        </span>
      </div>
    );
  // The view the header names (and the menu check-marks).
  const shownView: SessionView = effectiveView;
  // Switching view while a session transcript is open closes it: the open session belongs
  // to the view it was opened from, so browsing another one means leaving the conversation.
  const switchView = (next: SessionView): void => {
    setMenuOpenId(null);
    setView(next);
    if (!selectedId) return;
    const a = scopeWorkspaceId ?? workspacesForRunner[0]?.id;
    navigate(a ? `/workspaces/${encodeId(a)}` : `/runners/${encodeId(runner.id)}`);
  };
  const activeTag = tagFilter ? (sessionTags.find((t) => t.id === tagFilter) ?? null) : null;
  // Selection reads on the trailing edge, not in a leading icon column. The tag names already
  // need a swatch in front of them, and a leading check on top of that pushed every label so
  // far off the left edge that the menu read as right-heavy. Always rendered (blank when off)
  // so a row's width doesn't change as the selection moves.
  const checkSlot = (on: boolean): ReactNode => (
    <span className="scope-menu-check">{on ? <CheckOutlined /> : null}</span>
  );
  // ── The composer's model control ───────────────────────────────────────────────────────────
  // Provider, model, effort and speed used to be four pills; they are one button now, labelled
  // "model effort", with a menu that lists the current provider's models and puts the rarer
  // choices — provider, effort, speed — one level down, each row saying its current value the way
  // the session list's scope menu does. Each pick runs what its pill's onChange did. A menu
  // (unlike a Select) also fires for the value already chosen, and re-picking the running provider
  // would PATCH a reload for nothing — so every pick first checks that it changes something.
  // Another of the runner's accounts for this session, or Automatic: the server stores it — and on a
  // live session re-spawns the engine there, the runner carrying the conversation across; an ended one
  // takes it with its next resume. One the CLI says is signed out is a request for its sign-in, as a
  // provider row in that state is.
  const pickAccount = (account: string, signedOut: boolean): void => {
    if (!shownAccountEngine) return;
    if (signedOut) {
      navigate(`/providers?runner=${encodeId(runner.id)}&engine=${shownAccountEngine}`);
      return;
    }
    if (!selected) return;
    // An ended session whose switch onto this engine is still held: nothing on the server is on the
    // engine yet, so the account rides along with the switch, on the message that revives it.
    if (pendingResumeProvider && endedProviderPick) {
      setEndedProviderPick({ ...endedProviderPick, account });
      return;
    }
    // Nothing moves: Automatic picked again, or the account the session is already pinned to.
    if (account === AUTOMATIC_ACCOUNT ? sessionAutomatic : account === shownAccount && !sessionAutomatic) return;
    accountMut.mutate({ id: selected.id, account });
  };
  // `account`, when the pick was one of the engine's accounts listed under it rather than the engine's
  // own row: the switch lands the session there (SessionConfigDto.account) — Automatic's pick otherwise.
  const pickProvider = (v: string, account?: string): void => {
    if (v === shownProvider) {
      if (account !== undefined) pickAccount(account, false);
      return;
    }
    // A provider this runner can't run isn't a switch — it's a request for the sign-in (or
    // install) that would make it one. Go straight to that engine's row on the Providers page, as
    // the New Session picker's row does — or, for a choice that names its own fix (an account
    // pool), to that page. The chip keeps showing the provider still in use.
    const picked = providerSwitchChoices.find((c) => c.slug === v);
    if (picked?.unavailable) {
      navigate(
        picked.fixHref ??
          `/providers?runner=${encodeId(runner.id)}&engine=${picked.fixEngine ?? picked.slug}`,
      );
      return;
    }
    // Each provider owns its model space, so carry the running model only when the new one offers
    // it (two Anthropic accounts do; a third-party endpoint with its own list does not) and
    // otherwise take that provider's default. Mode and effort follow the model, exactly as a model
    // switch makes them.
    const nextModel = modelOptionsForProvider(v, runner.modelCatalog, configuredProviders).some(
      (option) => option.value === shownModel,
    )
      ? shownModel
      : defaultModelForProvider(v, runner.modelCatalog, configuredProviders, runner.runtimeDefaultModels);
    const drop = shownMode === 'Auto' && !supportsAuto(nextModel, v, configuredProviders, runner.modelCatalog);
    const currentEffort = live ? effectiveEffort : effort;
    const nextEffort = normalizeEffortForProvider(
      v,
      currentEffort,
      nextModel,
      runner.modelCatalog,
      configuredProviders,
    );
    if (live) {
      configMut.mutate({
        provider: v,
        ...(account !== undefined ? { account } : {}),
        ...(nextModel !== shownModel ? { model: nextModel } : {}),
        ...(drop ? { permissionMode: 'default' } : {}),
        ...(nextEffort !== currentEffort ? { effort: nextEffort } : {}),
      });
      return;
    }
    // Ended: hold the pick until the resume carries it, and move the values that depend on it now
    // — marking their seeds dirty, exactly as a manual Model or Mode edit does, so the seeding
    // effect doesn't put the old values back.
    setEndedProviderPick({ sessionId: selected!.id, provider: v, ...(account !== undefined ? { account } : {}) });
    // A pick that may mean stopping a run is not a settled question any more: whatever the last
    // answer was, it was about the provider before this one.
    setRunConflict(null);
    if (nextModel !== shownModel) {
      modelSeedState.current = dirtyContextSeed(modelContextKey);
      setModel(nextModel);
    }
    if (drop) {
      modeSeedState.current = dirtyContextSeed(modelContextKey);
      setMode('Default');
    }
    if (nextEffort !== currentEffort) {
      effortSeedState.current = dirtyContextSeed(effortContextKey);
      setEffort(nextEffort);
    }
  };
  const authErrorHelp: AuthErrorHelp = useMemo(
    () => ({
      provider: shownProvider,
      runnerName: runner.displayName || runner.name,
      runnerId: runner.id,
      runnerVersion: runner.version,
      googleLogin: runner.antigravity?.googleLogin,
      runtime: runtimeForProvider(shownProvider, configuredProviders),
      onConnectGemini: () => navigate(geminiProvider ? `/providers/${encodeId(geminiProvider.id)}` : '/providers/new/gemini'),
      onSwitchToGemini: geminiChoice && !geminiChoice.unavailable && !selectedTrashed && !selectedMissing
        ? () => pickProvider(geminiChoice.slug)
        : undefined,
      onOpenProviders: () => navigate(`/providers?runner=${encodeId(runner.id)}&engine=antigravity`),
      onInstall: runner.online && runner.antigravity?.supported ? () => installAntigravity.mutate() : undefined,
      installDisabled: installAntigravity.isPending || installDsh.isPending || runner.install?.status === 'installing' || runner.install?.status === 'pending',
      onEditDshKey: () => navigate(dshProviderRow ? `/providers/${encodeId(dshProviderRow.id)}` : '/providers'),
      onInstallDsh: runner.online && runner.capabilities?.includes(DSH_RUNNER_CAPABILITY) ? () => installDsh.mutate() : undefined,
      onRetry:
        retryText && !selectedTrashed && !selectedMissing
          ? retry.sessionMessage && selectedId
            ? () => {
                if (retryInFlight) return;
                resendFromSessionMutate(selectedId);
              }
            : () => {
                if (retryInFlight) return;
                sendMutate({ content: retryText, images: [], attachmentIds: retry.attachmentIds });
              }
          : undefined,
      retryDisabled: retryInFlight,
      retryText,
      // The provider gallery, not a preset vendor: the engine narrows it to a runtime, not to
      // whose key the user actually holds.
      onUseApiKey: () => navigate('/providers'),
    }),
    // `send.mutate` is referentially stable; `send` itself is not, and depending on it would
    // rebuild this every render and re-render the card through the context.
    [
      shownProvider,
      runner.name,
      runner.displayName,
      runner.id,
      runner.version,
      runner.online,
      runner.antigravity,
      runner.install,
      configuredProviders,
      geminiProvider,
      geminiChoice,
      pickProvider,
      installAntigravity.mutate,
      installAntigravity.isPending,
      installDsh.mutate,
      installDsh.isPending,
      dshProviderRow,
      runner.capabilities,
      shownModel,
      shownMode,
      effectiveEffort,
      effort,
      live,
      configMut.mutate,
      retry,
      retryText,
      retryInFlight,
      selectedId,
      selectedTrashed,
      selectedMissing,
      sendMutate,
      resendFromSessionMutate,
      navigate,
    ],
  );
  const pickModel = (v: string): void => {
    // A re-selection is still a preference, even when the session config already matches it.
    qc.setQueryData<Me>(meQuery().queryKey, (prev) =>
      prev ? {
        ...prev,
        preferences: {
          ...prev.preferences,
          defaultModels: { ...prev.preferences?.defaultModels, [shownProvider]: v },
        },
      } : prev,
    );
    modelPreferenceMut.mutate({ provider: shownProvider, model: v });
    if (v === shownModel) {
      modelSeedState.current = dirtyContextSeed(modelContextKey);
      return;
    }
    // Switching to a model that can't do Auto while Auto is selected would send a mode claude
    // rejects — snap back to Default.
    const drop = shownMode === 'Auto' && !supportsAuto(v, shownProvider, configuredProviders, runner.modelCatalog);
    // An OpenCode variant is model-defined: a model switch can strip it.
    const currentEffort = live ? effectiveEffort : effort;
    const nextEffort = normalizeEffortForProvider(
      shownProvider,
      currentEffort,
      v,
      runner.modelCatalog,
      configuredProviders,
    );
    const resetEffort = nextEffort !== currentEffort;
    if (live) {
      configMut.mutate({
        model: v,
        ...(drop ? { permissionMode: 'default' } : {}),
        ...(resetEffort ? { effort: nextEffort } : {}),
      });
      return;
    }
    modelSeedState.current = dirtyContextSeed(modelContextKey);
    setModel(v);
    if (drop) {
      modeSeedState.current = dirtyContextSeed(modelContextKey);
      setMode('Default');
    }
    if (resetEffort) {
      effortSeedState.current = dirtyContextSeed(effortContextKey);
      setEffort(nextEffort);
    }
  };
  const pickEffort = (v: string): void => {
    if (v === shownEffort) return;
    effortSeedState.current = dirtyContextSeed(effortContextKey);
    const normalized = normalizeEffortForProvider(
      shownProvider,
      v,
      shownModel,
      runner.modelCatalog,
      configuredProviders,
    );
    // Remember as the account default (replaces localStorage) so the next new session — here or on
    // iOS/macOS — starts at this effort. Optimistically patch the cached `me` so the seed effect
    // sees it, then persist best-effort.
    qc.setQueryData<Me>(meQuery().queryKey, (prev) =>
      prev ? { ...prev, preferences: { ...prev.preferences, defaultEffort: normalized } } : prev,
    );
    void api('/users/me/preferences', {
      method: 'PATCH',
      body: { defaultEffort: normalized },
    }).catch(() => {});
    if (live) configMut.mutate({ effort: normalized });
    else setEffort(normalized);
  };
  const pickFastMode = (next: boolean): void => {
    if (next === shownFastMode) return;
    if (live) configMut.mutate({ fastMode: next });
    else setFastMode(next);
  };
  const shownModelLabel = shownModelOptions.find((o) => o.value === shownModel)?.label ?? shownModel;
  const shownEffortLabel = shownEffortOptions.find((o) => o.value === shownEffort)?.label ?? shownEffort;
  const menuValue = (value: string): ReactNode => (
    <span className="scope-menu-value">
      <span className="scope-menu-value-text">{value}</span>
    </span>
  );
  // The runner's accounts of the session's engine, listed under it in the Provider submenu for a
  // session on built-in Codex or Claude to move between — each with its own quota, as the New Session
  // picker lists them. Only with two or more (one is nothing to choose), and only on a runner that
  // carries a conversation from one account to another: an older one would resume it where it was.
  const accountRows =
    shownAccountEngine && runner.capabilities?.includes(ACCOUNT_MOVE_CAPABILITY[shownAccountEngine])
      ? (providerSwitchChoices.find((choice) => choice.slug === shownAccountEngine)?.accounts ?? [])
      : [];
  const accountsOffered = accountRows.length > 1;
  // Automatic above them — Orbit keeps the session on an account with room, and moves it when the one
  // it is on hits its limit — where its workspace leaves the account to Orbit, as for a new session.
  // The session is on it unless an account was picked for it by hand.
  const shownWorkspaceRow = workspacesForRunner.find((w) => w.id === shownWorkspaceId) ?? null;
  const automaticHere = !!shownAccountEngine && automaticOfferedOn(shownAccountEngine, shownWorkspaceRow);
  const sessionAutomatic =
    automaticHere &&
    (pendingResumeProvider
      ? !pendingResumeAccount || pendingResumeAccount === AUTOMATIC_ACCOUNT
      : !(shownAccountEngine === 'claude' ? detailForSelected?.claudeAccountPinned : detailForSelected?.codexAccountPinned));
  // Another built-in engine's accounts, listed under it as the New Session picker lists them: a switch
  // onto that engine can land on any of them. On a runner that carries a conversation between them.
  const accountRowsFor = (engine: AccountEngine) => {
    const rows = runner.capabilities?.includes(ACCOUNT_MOVE_CAPABILITY[engine])
      ? (providerSwitchChoices.find((choice) => choice.slug === engine)?.accounts ?? [])
      : [];
    return rows.length > 1 ? rows : [];
  };
  // A task run whose model smart selection picked (docs/model-routing-design.md §9): the chip carries
  // a ✦ on a light blue ground, and its menu opens on why — the decision's own first sentence — and
  // on where to fix the model for every run. Only while the chip still shows the pick: a model
  // changed here is this run's own. A session opened by hand has no route, and a run on an Agent
  // without smart selection has one that was not applied, so both look as they always have — and
  // with the account's switch off (the default), so does every run.
  const smartRoute = (() => {
    if (me.data?.preferences?.modelRouting !== true) return null;
    const route = detailForSelected?.route;
    return selected?.taskId && route?.applied && route.level && route.model === shownModel ? route : null;
  })();
  const modelMenuItems: MenuProps['items'] = [
    ...(smartRoute
      ? [
          {
            key: 'smart-route',
            type: 'group' as const,
            label: (
              <div className="composer-route-note">
                <div className="composer-route-head">
                  <span className="composer-model-spark">✦</span>
                  Picked by smart selection · tier {smartRoute.level}
                </div>
                {smartRoute.reasons[0] && <div className="composer-route-reason">{smartRoute.reasons[0]}</div>}
                <div className="composer-route-reason">
                  Changing the model here applies to this run only. To fix the model for every run, set it on the
                  task.
                </div>
              </div>
            ),
          },
          { key: 'smart-route-divider', type: 'divider' as const },
        ]
      : []),
    // Only when there is somewhere to go: a second account with the same vendor, another endpoint on
    // the same CLI, or another of the runner's Codex accounts. One entry means no switch is possible,
    // and the row is left out rather than shown inert — the common case, one Claude sign-in and no
    // configured providers.
    ...(providerSwitchChoices.length > 1 || accountsOffered
      ? [
          {
            key: 'provider',
            label: (
              <span className="scope-menu-row">
                Provider
                {menuValue(providerSwitchChoices.find((c) => c.slug === shownProvider)?.label ?? shownProvider)}
              </span>
            ),
            children: providerSwitchChoices.flatMap((choice) => {
              // Carry the reason on the row itself, where it answers the question being asked
              // ("why can't I pick Claude?"). It stays pickable rather than greyed because picking
              // it does something useful — it goes where the fix is (see pickProvider), which is
              // the New Session picker's behaviour for the same row. The running provider is
              // exempt: it is the chip's own provider, and needs no parenthetical.
              const blocked = !!choice.unavailable && choice.slug !== shownProvider;
              // Each built-in engine's accounts under it, as the New Session picker lists them: on the
              // engine the session is on, the ones it moves between (switchAccount); under another,
              // the ones a switch onto that engine lands on (pickProvider with the account).
              const here = choice.slug === shownAccountEngine;
              const engine: AccountEngine | null =
                choice.slug === 'codex' || choice.slug === 'claude' ? choice.slug : null;
              const accounts = here ? (accountsOffered ? accountRows : []) : engine && !blocked ? accountRowsFor(engine) : [];
              const automatic =
                accounts.length > 0 && (here ? automaticHere : !!engine && automaticOfferedOn(engine, shownWorkspaceRow));
              const pick = (account: string, signedOut: boolean) => {
                if (here) return pickAccount(account, signedOut);
                if (signedOut) {
                  navigate(`/providers?runner=${encodeId(runner.id)}&engine=${engine}`);
                  return;
                }
                pickProvider(engine!, account);
              };
              return [
                {
                  key: `provider:${choice.slug}`,
                  // Distinguishable at a glance from a provider that is ready to run, without being
                  // inert: the identity is dimmed, the call to action is not.
                  className: blocked ? 'composer-provider-fix' : undefined,
                  label: (
                    <span className="scope-menu-row">
                      {blocked
                        ? `${choice.label} — ${choice.unavailable}, fix it →`
                        : choice.label}
                      {choice.labelDetail && <small className="np-label-detail">{choice.labelDetail}</small>}
                      {/* With its accounts listed, the tick is on the account the session runs on. */}
                      {checkSlot(choice.slug === shownProvider && accounts.length === 0)}
                    </span>
                  ),
                  onClick: () => pickProvider(choice.slug),
                },
                ...(automatic
                  ? [
                      {
                        key: `${choice.slug}-account:automatic`,
                        className: 'composer-account-row',
                        label: (
                          <span className="scope-menu-row">
                            <span className="composer-account-row-name">Automatic</span>
                            {menuValue('Switches to soonest reset')}
                            {checkSlot(here && sessionAutomatic)}
                          </span>
                        ),
                        onClick: () => pick(AUTOMATIC_ACCOUNT, false),
                      },
                    ]
                  : []),
                ...accounts.map((account) => ({
                  key: `${choice.slug}-account:${account.id}`,
                  className: `composer-account-row${account.nearLimit ? ' near-limit' : ''}${
                    account.unavailable ? ' composer-provider-fix' : ''
                  }`,
                  label: (
                    <span className="scope-menu-row">
                      <span className="composer-account-row-name">
                        {account.unavailable ? `${account.label} — ${account.unavailable}, sign in →` : account.label}
                      </span>
                      {!account.unavailable && account.quota && menuValue(account.quota)}
                      {checkSlot(here && account.id === shownAccount && !sessionAutomatic)}
                    </span>
                  ),
                  onClick: () => pick(account.id, !!account.unavailable),
                })),
              ];
            }),
          },
          { key: 'provider-divider', type: 'divider' as const },
        ]
      : []),
    ...shownModelOptions.map((option) => ({
      key: `model:${option.value}`,
      disabled: !shownProviderCapabilitiesResolved,
      label: (
        <span className="scope-menu-row">
          {option.label}
          {checkSlot(option.value === shownModel)}
        </span>
      ),
      onClick: () => pickModel(option.value),
    })),
    { key: 'effort-divider', type: 'divider' as const },
    {
      key: 'effort',
      label: (
        <span className="scope-menu-row">
          Effort
          {menuValue(shownEffortLabel)}
        </span>
      ),
      children: shownEffortOptions.map((option) => ({
        key: `effort:${option.value}`,
        label: (
          <span className="scope-menu-row">
            {option.label}
            {checkSlot(option.value === shownEffort)}
          </span>
        ),
        onClick: () => pickEffort(option.value),
      })),
    },
    // Fast mode, and only where there is one to offer: Claude's `/fast` and Codex's "Fast" tier
    // both exist on some models and not others. A row offered to a session that cannot have it
    // would be a control whose only outcome is being ignored — the server clamps it at dispatch
    // either way. A session that stored `true` and then moved to a model without a fast lane keeps
    // the stored value while the row is away, so going back to a model that has one restores what
    // was asked for rather than silently dropping it.
    ...(fastModeUsable
      ? [
          {
            key: 'speed',
            label: (
              <span className="scope-menu-row">
                Speed
                {menuValue(shownFastMode ? 'Fast' : 'Standard')}
              </span>
            ),
            children: [
              { value: false, label: 'Standard' },
              { value: true, label: 'Fast' },
            ].map((option) => ({
              key: `speed:${option.value ? 'fast' : 'standard'}`,
              label: (
                <span className="scope-menu-row">
                  {option.label}
                  {checkSlot(option.value === shownFastMode)}
                </span>
              ),
              onClick: () => pickFastMode(option.value),
            })),
          },
        ]
      : []),
    ...(smartRoute
      ? [
          { key: 'smart-route-open-divider', type: 'divider' as const },
          {
            key: 'open-task',
            label: <span className="composer-route-open">Open task ›</span>,
            onClick: () => navigate(`/tasks/${encodeId(selected.taskId)}`),
          },
        ]
      : []),
  ];
  const selectedSessionTagIds = ((selected?.tags ?? []) as SessionTagRef[]).map((t) => t.id);
  const setTagsFromMenu = ({
    key,
    selectedKeys,
  }: {
    key: string;
    selectedKeys: string[];
  }): void => {
    if (!selected || tagSaveInFlight.current || !sessionTags.some((t) => t.id === key)) return;
    const available = new Set(sessionTags.map((t) => t.id));
    tagSaveInFlight.current = true;
    setTagsMut.mutate({
      id: selected.id,
      tagIds: selectedKeys.filter((id) => available.has(id)),
    });
  };
  // One menu for everything that scopes the list: which slice (exclusive), then — below a
  // divider — the tag narrowing and sectioning. Tag entries only appear once the owner has
  // tags; the view entries always do, so Trash is reachable without ever having made one.
  // No group headings: the trigger already names the axis, and the shared check column is
  // what marks the three views as a mutually exclusive set.
  const scopeItems: MenuProps['items'] = [
    ...SESSION_VIEWS.map((v) => ({
      key: v.value,
      label: (
        <span className="scope-menu-row">
          {v.label}
          {checkSlot(shownView === v.value)}
        </span>
      ),
      onClick: () => switchView(v.value),
    })),
    ...(sessionTags.length > 0
      ? [
          { key: 'tag-divider', type: 'divider' as const },
          {
            key: 'filter',
            label: (
              <span className="scope-menu-row">
                Filter by Tag
                {activeTag && (
                  <span className="scope-menu-value">
                    <span className="session-section-dot" style={{ background: activeTag.color }} />
                    <span className="scope-menu-value-text">{activeTag.name}</span>
                  </span>
                )}
              </span>
            ),
            children: [
              {
                key: 'all',
                // Colourless by nature, but it still takes the swatch column (an unpainted
                // dot) so every name in the menu starts on the same edge.
                label: (
                  <span className="scope-menu-row">
                    <span className="scope-tag-label">
                      <span className="session-section-dot" />
                      All
                    </span>
                    {checkSlot(tagFilter === null)}
                  </span>
                ),
                onClick: () => setTagFilter(null),
              },
              // Colour is how a tag is identified everywhere else (the row dots, the
              // "Group by Tag" headings), so carry the swatch here too.
              ...sessionTags.map((t) => ({
                key: t.id,
                label: (
                  <span className="scope-menu-row">
                    <span className="scope-tag-label">
                      <span className="session-section-dot" style={{ background: t.color }} />
                      {t.name}
                    </span>
                    {checkSlot(tagFilter === t.id)}
                  </span>
                ),
                onClick: () => setTagFilter(tagFilter === t.id ? null : t.id),
              })),
            ],
          },
          {
            key: 'group',
            label: (
              <span className="scope-menu-row">
                Group by Tag
                {checkSlot(groupByTag)}
              </span>
            ),
            onClick: () => setGroupByTag((g) => !g),
          },
        ]
      : []),
    // Where iOS keeps it, in the menu that scopes the list (§3.4). Only where folders show: a list
    // narrowed to or grouped by a tag, or Trash, would have nowhere to draw the new one.
    ...(scopeWorkspaceId && listShowsFolders(shownView, listByTag)
      ? [
          { key: 'folder-divider', type: 'divider' as const },
          {
            key: 'new-folder',
            label: <span className="scope-menu-row">{FOLDER_COPY.newFolder}</span>,
            onClick: startNewFolder,
          },
        ]
      : []),
  ];
  // Header subtitle keeps run outcome and lifecycle location visibly separate, followed by
  // last activity. Task state remains on its own task affordance above the title.
  const headTime = selected
    ? fmtTime(selected.lastTurnAt ?? selected.startedAt ?? selected.createdAt)
    : '';
  const headRunWord = selected ? statusLabel(selectedSession ?? selected, selectedWatchingWord) : '';
  const headLifecycleWord = selectedLifecycleState
    ? sessionLifecycleLabel(selectedLifecycleState)
    : null;
  const headSub = composing
    ? [headWorkspaceName, openFolder?.name, 'New session'].filter(Boolean).join(' · ')
    : selected
      ? [
          headRunWord,
          // A session you filed reads "Completed" on both axes; say it once rather than twice.
          headLifecycleWord === headRunWord ? null : headLifecycleWord,
          headTime,
        ]
          .filter(Boolean)
          .join(' · ')
      : selectedMissing
        ? 'Session not found'
      : selectedId
        ? 'Starting…'
        : '';
  const composerPlaceholder = selectedTrashed
    ? 'Restore this session to continue'
    : selectedMissing
      ? 'Session not found'
      : sameSessionSendBlocked
        ? sameSessionSendBlockedCopy
        : !runner.online
          ? 'Runner offline'
          : replyTo
            ? replyTo.placeholder
            : selectedId
              ? 'Reply…'
              : 'Send this workspace a task…';

  return (
    <div className={`workspace-split${selectedId || composingRoute ? ' show-conversation' : ''}`}>
      <aside className={`session-col${openProjectId ? ' session-project-page' : ''}`} style={{ width: colWidth }}>
        {openProjectId ? (
          <div className="session-col-head session-folder-head session-project-page-header">
            <button type="button" className="session-folder-back" aria-label={FOLDER_COPY.back(headWorkspaceName)}
              title={FOLDER_COPY.back(headWorkspaceName)} onClick={leaveProjectSessions}>
              <LeftOutlined />
            </button>
            <span className="session-folder-titles">
              <span className="session-folder-title">{pageProjectTitle}</span>
              <span className="session-folder-workspace">{SESSION_PROJECT_COPY.pageSubtitle(projectMembers.length)}</span>
            </span>
            <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: [
              { key: 'project', label: SESSION_PROJECT_COPY.openProject,
                onClick: () => navigate(`/projects/${encodeId(openProjectId)}`) },
              { key: 'coordinator', label: SESSION_PROJECT_COPY.openCoordinator, disabled: !pageMenuCoordinator,
                onClick: () => pageMenuCoordinator && navigateWithPaneSlide('push', () =>
                  navigate(sessionPath(pageMenuCoordinator.id), { state: stampFromList() })) },
            ] }}>
              <button type="button" className="session-kebab session-folder-head-more" aria-label="Project actions">
                <MoreOutlined />
              </button>
            </Dropdown>
          </div>
        ) : openFolder ? (
          // A folder's page: back to the workspace's list, the folder (and the workspace it is in),
          // and the folder's own two entries. It lists the view it was opened from.
          <div className="session-col-head session-folder-head">
            <button
              type="button"
              className="session-folder-back"
              aria-label={FOLDER_COPY.back(headWorkspaceName)}
              title={FOLDER_COPY.back(headWorkspaceName)}
              onClick={() => leaveFolder()}
            >
              <LeftOutlined />
            </button>
            <span className="session-folder-titles">
              {folderEdit?.id === openFolder.id ? (
                <input
                  className={`folder-name-input${folderEdit.error ? ' error' : ''}`}
                  autoFocus
                  maxLength={60}
                  aria-label="Folder name"
                  value={folderEdit.draft}
                  readOnly={folderEdit.saving}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setFolderEdit({ ...folderEdit, draft: e.target.value, error: null })}
                  onKeyDown={folderEditKeys}
                  onBlur={() => void saveFolderEdit()}
                />
              ) : (
                <span className="session-folder-title">{openFolder.name}</span>
              )}
              <span className="session-folder-workspace">{headWorkspaceName}</span>
            </span>
            <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: folderMenuItems(openFolder) }}>
              <span className="session-kebab session-folder-head-more" role="button" aria-label={FOLDER_COPY.more}>
                <MoreOutlined />
              </span>
            </Dropdown>
          </div>
        ) : (
          <div className="session-col-head">
            <span className={`workspace-status-dot ${runner.online ? 'online' : ''}`} />
            <span className="session-col-title">{headWorkspaceName}</span>
            {/* View + tag filter/grouping, folded into one menu rather than a tab row and a
                chip row — both read as clutter in a narrow column, and Open is nearly always
                the answer. The trigger names the current view so a list scoped to
                Completed/Trash always explains itself. (The native clients still tab.) */}
            <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: scopeItems }}>
              <span
                className={`session-scope-menu${shownView !== 'open' || tagFilter || groupByTag ? ' on' : ''}`}
                title="Switch view, filter and group"
              >
                {SESSION_VIEWS.find((v) => v.value === shownView)?.label}
                <DownOutlined />
              </span>
            </Dropdown>
          </div>
        )}
        {openFolder && folderEdit?.id === openFolder.id && folderEdit.error && (
          <div className="session-folder-error">{folderEdit.error}</div>
        )}
        {openProjectId && (
          <div className="session-project-page-progress">
            {pageTaskCounts && (
              <>
                <SessionProjectProgressBar counts={pageTaskCounts} runningCount={pageRunningCount} />
                <span>{SESSION_PROJECT_COPY.pageProgress(pageTaskCounts.done, pageTaskCounts.total, pageRunningCount)}</span>
              </>
            )}
            <a href={`/projects/${encodeId(openProjectId)}`} aria-label={SESSION_PROJECT_COPY.openProject}
              onClick={(e) => { e.preventDefault(); navigate(`/projects/${encodeId(openProjectId)}`); }}>↗</a>
          </div>
        )}
        {!openProjectId && <div className={`session-new ${composing ? 'active' : ''}`} onClick={goNew}>
          <PlusOutlined />
          <span>New session</span>
          {isStandalone && !isMobile && <kbd className="session-new-kbd">{NEW_SESSION_HINT}</kbd>}
        </div>}
        {/* The palette's click target, shaped like the field it opens rather than a bare glyph in
            the header. ⌘K stays the primary way in; this is the only one on a touch device, where
            there's no keyboard to press it with and a `title` tooltip never shows — so the label
            and the target size have to carry it. */}
        {!openProjectId && <div
          className="session-search"
          role="button"
          tabIndex={0}
          onClick={openSessionSearch}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            openSessionSearch();
          }}
        >
          <SearchOutlined />
          <span>Search sessions</span>
          {!isMobile && <kbd className="session-search-kbd">{SEARCH_HINT}</kbd>}
        </div>}
        <div
          className="workspace-sessions session-col-list autohide-scrollbar"
          ref={listRef}
          onScroll={onSessionListScroll}
        >
          {openProjectId
            ? projectMembers.length === 0 && !loadingSessions &&
              <div className="chat-note">{projectSessionsQ.isError || completedProjectSessionsQ.isError ? 'Couldn’t load project sessions.' : 'No sessions in this project.'}</div>
            : openFolder
            ? listedSessions.length === 0 &&
              !loadingSessions && <div className="chat-note">No sessions in this folder.</div>
            : visibleSessions.length === 0 &&
              !loadingSessions && (
                <div className="chat-note">
                  {tagFilter
                    ? 'No sessions with this tag.'
                    : view === 'open'
                      ? 'No sessions yet.'
                      : view === 'completed'
                        ? 'No completed sessions.'
                        : 'Trash is empty.'}
                </div>
              )}
          {/* The workspace's folders on top (§3.3), New Folder…'s field above them while it is
              open. A folder row reports for the sessions filed in it, which the time sections
              below leave out. */}
          {!openProjectId && !openFolder && folderEdit?.id === null && folderEditRow(null)}
          {!openProjectId && folderListing?.folders.map((row) =>
            folderEdit?.id === row.folder.id ? folderEditRow(row.folder.id) : folderRowView(row),
          )}
          {sections.map((sec) => (
            <section key={sec.key} className={openProjectId && sec.key === 'Coordinator' ? 'session-project-coordinator' : undefined}>
              {sec.key === 'Pinned' ? (
                <button
                  type="button"
                  className="session-section-head session-section-fold"
                  aria-expanded={!pinnedCollapsed}
                  onClick={togglePinned}
                >
                  {sec.title}
                  <RightOutlined
                    className={`session-section-chev${pinnedCollapsed ? '' : ' open'}`}
                    aria-hidden
                  />
                </button>
              ) : (
                <div className="session-section-head">
                  {sec.tag && (
                    <span className="session-section-dot" style={{ background: sec.tag.color }} />
                  )}
                  {sec.title}
                </div>
              )}
              {sec.sessions.map((s) => {
                if (s.kind === 'project') {
                  const coordinator = s.coordinator;
                  const openTarget = () => {
                    if (swipeClickGuard.current) { swipeClickGuard.current = false; return; }
                    if (swipeOpen) { setSwipeOpen(null); return; }
                    setMenuOpenId(null);
                    if (s.target.kind === 'project') enterProjectSessions(s.target.id);
                    else navigateWithPaneSlide('push', () =>
                      navigate(sessionPath(s.target.id), { state: stampFromList() }));
                  };
                  const drag = swipeDrag?.id === s.id ? swipeDrag : null;
                  const offset = drag?.dx ?? restingOffset(swipeOpen?.id === s.id ? swipeOpen.side : null,
                    { leadingWidth: SWIPE_ACTION_WIDTH, trailingWidth: SWIPE_ACTION_WIDTH });
                  return (
                    <SessionProjectListRow
                      key={s.id}
                      project={s}
                      active={s.members.some((member) => member.id === selectedId) ||
                        selectedSession?.projectMembership?.projectId === s.projectId}
                      onOpen={() => {
                        if (swipeClickGuard.current) { swipeClickGuard.current = false; return; }
                        if (swipeOpen) { setSwipeOpen(null); return; }
                        setMenuOpenId(null);
                        enterProjectSessions(s.projectId);
                      }}
                      menuOpen={menuOpenId === s.id}
                      onMenuOpenChange={(open) => { setMenuOpenId(open ? s.id : null); if (open) setSwipeOpen(null); }}
                      swipe={isMobile && coordinator ? {
                        offset, dragging: !!drag,
                        onStart: (e) => onRowTouchStart(e, coordinator, false, s.id),
                        onMove: onRowTouchMove, onEnd: onRowTouchEnd, onCancel: onRowTouchCancel,
                        onAction: (action) => runSwipeAction(action, coordinator),
                      } : undefined}
                      menu={{
                        items: [
                          { key: 'session', label: SESSION_PROJECT_COPY.openSession, disabled: s.target.kind !== 'session' },
                          { key: 'sessions', label: SESSION_PROJECT_COPY.sessions },
                          { key: 'project', label: SESSION_PROJECT_COPY.openProject },
                          { type: 'divider' as const },
                          { key: 'pin', label: coordinator?.pinnedAt ? SESSION_PROJECT_COPY.unpin : SESSION_PROJECT_COPY.pin, disabled: !coordinator },
                          { key: 'move', label: SESSION_PROJECT_COPY.move, disabled: !coordinator },
                        ],
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation();
                          setMenuOpenId(null);
                          if (key === 'session') openTarget();
                          else if (key === 'sessions') enterProjectSessions(s.projectId);
                          else if (key === 'project') navigate(`/projects/${encodeId(s.projectId)}`);
                          else if (coordinator) runSwipeAction(key as SwipeAction, coordinator);
                        },
                      }}
                    />
                  );
                }
                const actionSession = selectedSession?.id === s.id ? selectedSession : s;
                const memberView = sessionRowView(actionSession);
                const swipeActions = sessionSwipeActions(memberView);
                const swipeSizes = swipeWidths(memberView);
                const canCompleteRow = sessionCapabilityOf(actionSession, 'canComplete', true);
                const canRestoreRow = sessionCapabilityOf(actionSession, 'canRestore', true);
                // Open and Completed rows open their transcript; only
                // Trash rows stay closed.
                const openable = memberView !== 'trash';
                // The selected row may have a fresher detail payload than the list poll. Use the
                // merged row for both status surfaces so the banner and its list warning point at
                // the same canonical obligation during that refresh gap.
                const watching = sessionWatching(watchingBySession, s.id);
                const line = sessionLine(actionSession, openable, watching);
                const drag = swipeDrag?.id === s.id ? swipeDrag : null;
                const swipeTx = drag
                  ? drag.dx
                  : restingOffset(swipeOpen?.id === s.id ? swipeOpen.side : null, swipeSizes);
                // As on iOS, a full swipe runs the leading edge's first action only when it can run.
                const canFullSwipe = memberView === 'open' ? canCompleteRow : canRestoreRow;
                const swipeButtons = {
                  complete: { label: 'Complete', icon: <CheckOutlined />, disabled: !canCompleteRow },
                  restore: { label: 'Move to Open', icon: <UndoOutlined />, disabled: !canRestoreRow },
                  pin: s.pinnedAt
                    ? { label: 'Unpin', icon: <PushpinFilled />, disabled: false }
                    : { label: 'Pin', icon: <PushpinOutlined />, disabled: false },
                  share: { label: 'Share', icon: <ExportOutlined />, disabled: false },
                  move: { label: 'Move', icon: <FolderOutlined />, disabled: false },
                  delete: { label: 'Delete', icon: <DeleteOutlined />, disabled: false },
                  purge: { label: 'Delete Permanently', icon: <DeleteOutlined />, disabled: false },
                };
                const menuItem = (action: SwipeAction) => ({
                  key: action,
                  icon: swipeButtons[action].icon,
                  disabled: swipeButtons[action].disabled,
                  danger: action === 'delete' || action === 'purge',
                  label: action === 'complete' ? (
                    <div className="session-menu-label">
                      <span>Complete</span>
                      <kbd>{COMPLETE_SESSION_HINT}</kbd>
                    </div>
                  ) : action === 'move' ? MOVE_COPY.action
                    : action === 'share' ? 'Share…'
                      : action === 'purge' ? 'Delete Permanently…'
                        : swipeButtons[action].label,
                  title: action === 'complete'
                    ? !canCompleteRow ? 'Complete unavailable right now'
                      : isSessionLive(actionSession) ? 'Ends the run and moves to Completed' : undefined
                    : action === 'restore' && !canRestoreRow ? 'Move to Open unavailable right now' : undefined,
                });
                const menuItems: MenuProps['items'] = memberView === 'trash'
                  ? [menuItem('restore'), { type: 'divider' }, menuItem('purge')]
                  : [
                      ...swipeActions.leading.map(menuItem),
                      { type: 'divider' },
                      menuItem('share'),
                      ...(!s.projectMembership || s.projectMembership.role === 'COORDINATOR' ? [menuItem('move')] : []),
                      { type: 'divider' },
                      menuItem('delete'),
                    ];
                return (
                  <div
                    className={`session-row${openable ? '' : ' no-open'}${s.id === selectedId ? ' active' : ''}${menuOpenId === s.id ? ' menu-open' : ''}`}
                    key={s.id}
                    onClick={() => {
                      if (swipeClickGuard.current) {
                        swipeClickGuard.current = false;
                        return; // this click merely ends a swipe
                      }
                      if (swipeOpen) {
                        setSwipeOpen(null); // a tap anywhere on an open row just closes it
                        return;
                      }
                      setMenuOpenId(null);
                      if (openable)
                        navigateWithPaneSlide('push', () =>
                          navigate(sessionPath(s.id), { state: stampFromList() }),
                        );
                    }}
                    onTouchStart={(e) => onRowTouchStart(e, actionSession, canFullSwipe)}
                    onTouchMove={onRowTouchMove}
                    onTouchEnd={onRowTouchEnd}
                    onTouchCancel={onRowTouchCancel}
                  >
                    {isMobile &&
                      (['leading', 'trailing'] as const).map((side) => (
                        <div
                          key={side}
                          className={`session-swipe-actions ${side}${drag ? ' dragging' : ''}${side === 'leading' && drag?.armed ? ' armed' : ''}`}
                          style={{ width: Math.max(0, side === 'leading' ? swipeTx : -swipeTx) }}
                        >
                          {swipeActionsOnScreen(side, swipeActions[side]).map((action) => (
                            <button
                              key={action}
                              type="button"
                              className={`session-swipe-action ${action}`}
                              aria-label={swipeButtons[action].label}
                              aria-disabled={swipeButtons[action].disabled}
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                runSwipeAction(action, s);
                              }}
                            >
                              <span className="session-swipe-glyph">{swipeButtons[action].icon}</span>
                              <span className="session-swipe-title" aria-hidden="true">
                                {swipeButtons[action].label}
                              </span>
                            </button>
                          ))}
                        </div>
                      ))}
                    <div
                      className={`session-swipe${drag ? ' dragging' : ''}`}
                      style={swipeTx ? { transform: `translateX(${swipeTx}px)` } : undefined}
                    >
                      <span className="session-icon">
                        <StatusIcon session={actionSession} watching={watching?.word} />
                      </span>
                      <div className="session-main">
                        <SessionTitleRow session={s} hoverTipOpen={hoverTipOpen} />
                        {/* Tags lead the second line and the reply preview follows them. They sat
                            beside the title as bare colour dots until the naming pass started
                            writing semantic ones ("登录", "性能"): a dot cannot show a word, so the
                            meaning lived only in a tooltip. Here they read at a glance and the
                            preview yields, being the echo of a reply rather than the handle you
                            file the session under. */}
                        <div className="session-sub">
                          <SessionTagChips
                            tags={s.tags as SessionTagRef[] | null | undefined}
                            tooltipOpen={hoverTipOpen}
                          />
                          <div
                            className={`session-preview${line.tone === 'preview' ? '' : ` tone-${line.tone}`}`}
                          >
                            {line.text}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="session-right">
                      <div className="session-actions" onClick={(e) => e.stopPropagation()}>
                        <Dropdown
                          trigger={['click']}
                          placement="bottomRight"
                          autoFocus
                          classNames={{ root: 'session-row-menu' }}
                          open={menuOpenId === s.id}
                          onOpenChange={(open) => {
                            setMenuOpenId((current) => open ? s.id : current === s.id ? null : current);
                            if (open) setSwipeOpen(null);
                          }}
                          menu={{
                            items: menuItems,
                            onClick: ({ key, domEvent }) => {
                              domEvent.stopPropagation();
                              setMenuOpenId(null);
                              runSwipeAction(key as SwipeAction, s);
                            },
                          }}
                        >
                          <button
                            type="button"
                            className="session-kebab"
                            aria-label="More actions"
                            aria-haspopup="menu"
                            aria-expanded={menuOpenId === s.id}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key !== 'ArrowDown') return;
                              e.preventDefault();
                              e.stopPropagation();
                              setMenuOpenId(s.id);
                            }}
                          >
                            <EllipsisOutlined />
                          </button>
                        </Dropdown>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          {/* Foot of the loaded window while a page is in flight, so a scroll that outruns the
              fetch (or a switch to a workspace not yet cached) shows progress rather than an
              abrupt end of list. */}
          {loadingSessions && (
            <div className="session-list-more">
              <Spin size="small" />
            </div>
          )}
        </div>
      </aside>

      <div
        className={`session-resizer${resizing ? ' resizing' : ''}`}
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />

      <div
        className="workspace-view"
        onDragEnter={onSessionDragEnter}
        onDragOver={onSessionDragOver}
        onDragLeave={onSessionDragLeave}
        onDrop={onSessionDrop}
      >
        {/* Drop-to-upload hint covering the whole session pane while files are dragged over it. */}
        {dragging && (
          <div className="workspace-dropzone">
            <PaperClipOutlined /> Drop files to upload
          </div>
        )}
        <div className="workspace-header">
          {isMobile && (
            <button
              type="button"
              className="workspace-back-mobile"
              aria-label="Back to sessions"
              onClick={() => {
                const a = scopeWorkspaceId ?? workspacesForRunner[0]?.id;
                const list = a ? `/workspaces/${encodeId(a)}${listSearch}` : `/runners/${encodeId(runner.id)}${listSearch}`;
                // A real back when the list is the entry behind this one, so returning unwinds
                // the push instead of stacking a third entry on top of it. A deep-linked
                // conversation has no such entry: replace it, which still lands on the list —
                // and, unlike a bare back, never steps out of the app.
                navigateWithPaneSlide('pop', () =>
                  arrivedFromList() ? navigate(-1) : navigate(list, { replace: true }),
                );
              }}
            >
              <ArrowLeftOutlined />
            </button>
          )}
          <div className="workspace-header-main">
            {selected?.taskId && !composing && (
              <button
                type="button"
                className="workspace-header-task"
                title={`Back to task · ${selected.taskTitle ?? ''}`}
                onClick={() => navigate(`/tasks/${encodeId(selected.taskId)}`)}
              >
                <ArrowLeftOutlined />
                <span className="workspace-header-task-name">{selected.taskTitle ?? 'Back to task'}</span>
              </button>
            )}
            {projectBack && !composing && (
              <button
                type="button"
                className="workspace-header-task"
                title={projectBack.title ? `Back to project · ${projectBack.title}` : 'Back to project'}
                onClick={() => navigate(projectBack.path)}
              >
                <ArrowLeftOutlined />
                <span className="workspace-header-task-name">{projectBack.title ?? 'Back to project'}</span>
              </button>
            )}
            <div className="workspace-title-line">
              {editingTitle && selected && !composing ? (
                <>
                  <span ref={titleMirrorRef} className="workspace-name-mirror" aria-hidden="true">
                    {titleDraft || ' '}
                  </span>
                  <input
                    className="workspace-name-input"
                    style={{ width: titleInputW }}
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onFocus={(e) => {
                      // Select all (double-click-to-rename = type replaces), but anchor the
                      // caret at the START so a long title shows its head, not its tail.
                      const el = e.currentTarget;
                      el.setSelectionRange(0, el.value.length, 'backward');
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return; // let the IME (e.g. pinyin) keep Enter
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelTitleEdit.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={() => {
                      setEditingTitle(false);
                      if (cancelTitleEdit.current) {
                        cancelTitleEdit.current = false;
                        return;
                      }
                      const t = titleDraft.trim();
                      // Entering rename mode and committing is an explicit ownership choice even
                      // when the text is unchanged: the server uses that same-text write to opt a
                      // project-managed title out of future synchronization (the ABA case).
                      if (t) renameMut.mutate({ id: selected.id, title: t });
                    }}
                  />
                </>
              ) : (
                <div
                  className="workspace-name"
                  {...(selected && !selectedTrashed && !composing
                    ? {
                        onDoubleClick: () => {
                          setTitleDraft(selected.title);
                          setEditingTitle(true);
                        },
                        title: 'Double-click to rename',
                      }
                    : {})}
                >
                  {composing
                    ? 'New session'
                    : (selected?.title ?? (selectedMissing ? 'Session not found' : selectedId ? 'Starting…' : headWorkspaceName))}
                </div>
              )}
              {!composing && (
                <CoordinatorBadge projectId={selectedSession?.projectId} />
              )}
              {!composing && selected && selectedShared && (
                <button
                  type="button"
                  className="session-shared-pill"
                  title="Anyone with the link can view this session — open its sharing settings"
                  onClick={() => setShareOpen(true)}
                >
                  <GlobalOutlined /> Shared · Live
                </button>
              )}
              {!composing && selectedId && !selectedTrashed && !selectedMissing && (
                <SessionWatchBadges sessionId={selectedId} />
              )}
            </div>
            <div className="workspace-sub">{headSub}</div>
          </div>
          {selected && !composing && (
            <>
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                open={headerMenuOpen}
                onOpenChange={setHeaderMenuOpen}
                menu={{
                  selectable: !selectedTrashed,
                  multiple: !selectedTrashed,
                  selectedKeys: selectedTrashed ? [] : selectedSessionTagIds,
                  onSelect: selectedTrashed ? undefined : setTagsFromMenu,
                  onDeselect: selectedTrashed ? undefined : setTagsFromMenu,
                  items: selectedTrashed
                    ? [
                        {
                          key: 'restore',
                          icon: <UndoOutlined />,
                          label: 'Restore to Open',
                          disabled: !selectedCanRestore,
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            requestRestore(selected);
                          },
                        },
                        { type: 'divider' },
                        {
                          key: 'purge',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete permanently',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            confirmPurge({ id: selected.id, title: selected.title });
                          },
                        },
                      ]
                    : [
                        // Keyboard-only would leave the feature undiscoverable, and unreachable
                        // for anyone on a trackpad-and-touch device.
                        {
                          key: 'find',
                          icon: <SearchOutlined />,
                          label: `Find in session · ${FIND_HINT}`,
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            openSessionFind();
                          },
                        },
                        ...(sessionTags.length > 0
                          ? [
                              {
                                type: 'group' as const,
                                label: 'Tags',
                                children: sessionTags.map((t) => ({
                                  key: t.id,
                                  disabled: setTagsMut.isPending,
                                  label: (
                                    <span className="scope-menu-row">
                                      <span className="scope-tag-label">
                                        <span
                                          className="session-section-dot"
                                          style={{ background: t.color }}
                                        />
                                        {t.name}
                                      </span>
                                      {checkSlot(selectedSessionTagIds.includes(t.id))}
                                    </span>
                                  ),
                                })),
                              },
                            ]
                          : []),
                        { type: 'divider' as const },
                        // A Completed session is retained, not gone — offer the same move
                        // its row has in Completed, so it can return to Open in place.
                        ...(selectedCompleted
                          ? [
                              {
                                key: 'restore',
                                icon: <UndoOutlined />,
                                label: 'Move to Open',
                                disabled: !selectedCanRestore,
                                onClick: () => {
                                  setHeaderMenuOpen(false);
                                  requestRestore(selected);
                                },
                              },
                              {
                                key: 'move',
                                icon: <FolderOutlined />,
                                label: MOVE_COPY.action,
                                onClick: () => openMove(selectedSession ?? selected),
                              },
                              { type: 'divider' as const },
                            ]
                          : selectedLifecycleState === 'OPEN'
                            ? [
                                {
                                  key: 'complete',
                                  icon: <CheckOutlined />,
                                  label: 'Complete',
                                  disabled: !selectedCanComplete,
                                  onClick: () => {
                                    setHeaderMenuOpen(false);
                                    requestComplete(selected);
                                  },
                                },
                                // Filing it, beside the other move it can make (§2).
                                {
                                  key: 'move',
                                  icon: <FolderOutlined />,
                                  label: MOVE_COPY.action,
                                  onClick: () => openMove(selectedSession ?? selected),
                                },
                                { type: 'divider' as const },
                              ]
                            : []),
                        // Two words for two links (docs/share-links-design.md §8): Copy link is
                        // the signed-in address, for yourself; Share… is the public one. Keeping a
                        // copy needs neither: Download HTML reads the transcript as its owner.
                        {
                          key: 'copy-link',
                          icon: <LinkOutlined />,
                          label: 'Copy link',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            copySessionLink(selected);
                          },
                        },
                        {
                          key: 'share',
                          icon: <GlobalOutlined className={selectedShared ? 'session-share-icon-live' : undefined} />,
                          label: selectedShared ? (
                            <span className="scope-menu-row">
                              Share…<span className="scope-menu-value">Live link</span>
                            </span>
                          ) : (
                            'Share…'
                          ),
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            setShareOpen(true);
                          },
                        },
                        {
                          key: 'download-html',
                          icon: <DownloadOutlined />,
                          label: downloadingHtml ? 'Preparing HTML…' : 'Download HTML',
                          disabled: downloadingHtml,
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            void downloadHtml(selectedSession ?? selected);
                          },
                        },
                        { type: 'divider' },
                        {
                          key: 'delete',
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: 'Delete',
                          onClick: () => {
                            setHeaderMenuOpen(false);
                            requestTrash(selected);
                          },
                        },
                      ],
                }}
              >
                <Button type="text" icon={<MoreOutlined />} title="More actions" />
              </Dropdown>
            </>
          )}
        </div>

        {selected && !selectedTrashed && !composing && (
          <ShareModal
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            kind="SESSION"
            rootId={selected.id}
          />
        )}
        {shareRowId && (
          <ShareModal open onClose={() => setShareRowId(null)} kind="SESSION" rootId={shareRowId} />
        )}
        <SessionMoveModal
          open={!!moveTarget}
          session={moveTarget}
          workspace={moveTarget?.workspace ?? (scopeWorkspaceId ? { id: scopeWorkspaceId, name: headWorkspaceName } : null)}
          folders={moveTarget?.workspace
            ? (foldersQ.data ?? []).filter((f) => f.workspaceId === moveTarget.workspace!.id)
            : workspaceFolders}
          onClose={() => setMoveTarget(null)}
        />

        {/* Flush under the header, above everything that scrolls or that the conversation pushes
            around: what this session is being asked to decide is STATE — recomputed from the ledger
            on every read — and state that sat in the transcript's vertical flow read as a message
            nobody sent. One line until it is asked to be more. */}
        {selectedId && !selectedTrashed && (
          <SessionDecisionStrip
            sessionId={selectedId}
            projectId={selectedSession?.projectId ?? null}
            cards={decisionCards}
            confirmation={
              openSettlementIn?.sessionId === selectedId ? openSettlementIn.question : false
            }
            // Named in the card's own words, with how long the run has waited — never a number
            // first. Only when the card below is drawn in this session, so a press always arrives;
            // and not while its report is still with its reviewer, which is somebody else's to look
            // at first — the card is there, but nothing points the owner at it (contract §5 N1).
            ownerConfirmation={
              ownerWaiting && ownerConfirmation.data && ownerWaiting.review?.state !== 'UNDER_REVIEW'
                ? {
                    title: ownerConfirmation.data.title,
                    ageSeconds: Math.max(
                      0,
                      Math.floor((Date.now() - Date.parse(ownerWaiting.requestedAt)) / 1000),
                    ),
                  }
                : null
            }
            // The exception cards the owner presses, with how long each has been theirs and which
            // side of the reader it sits on now: unlike a question, one can be above.
            exceptions={ownerExceptionRows.map((row) => ({
              row,
              ageSeconds: Math.max(
                0,
                Math.floor((Date.now() - Date.parse(row.escalatedAt ?? row.waitingSince)) / 1000),
              ),
              above: openItemsAbove.split(' ').includes(row.itemId),
            }))}
            // The strip states the fact and this takes the reader to the one place it can be
            // answered: the card the server delivered into this conversation. A second set of
            // buttons up here would be two faces racing for one answer.
            onOpenCriteria={(row) => revealCriteriaCard(row.intentId)}
          />
        )}

        {stuck && (
          <button
            className={stuck.loading ? 'chat-sticky-question chat-sticky-loading' : 'chat-sticky-question'}
            title={stuck.text}
            onClick={() => {
              const seq = stuck?.seq;
              if (!seq) return;
              const card = scrollRef.current?.querySelector<HTMLElement>(
                `.chat-user[data-seq="${seq}"], [data-sticky-label][data-seq="${seq}"]`,
              );
              revealCard(card, 'start', false);
            }}
          >
            {/* The arrow points up at the turn the bar names, whoever's turn it was. */}
            <span className="chat-sticky-label">↑ {stuck.label}</span>
            <span className="chat-sticky-text">
              {stuck.loading ? 'Loading earlier messages…' : stuck.text}
            </span>
          </button>
        )}

        <div className="workspace-scroll-wrap">
          {selectedMissing ? (
            <div className="workspace-sessions" ref={scrollRef}>
              <div className="chat-note">Session not found.</div>
            </div>
          ) : selectedId ? (
            <div className="workspace-sessions" ref={scrollRef}>
              {/* A tail-first transcript always has more above it: while a page is in flight this
                  says so, and otherwise it is the way to the first message, which scrolling alone
                  never reaches (see jumpToStart). Pinned to the top of the viewport rather than
                  left at the top of the content — content-top is only on screen for the instant
                  before the page it triggers lands and re-anchors the view a page below it. Offered
                  only once the reader has left the live tail, the mirror of the jump-to-bottom
                  button: at the tail nobody is looking for the beginning, and the pill floats over
                  the transcript, so there it is only something covering a message. */}
              {(loadingOlder || (hasMoreOlder && !atBottom)) && (
                <div className="chat-older-top">
                  {loadingOlder ? (
                    <span className="chat-older-pill">Loading earlier messages…</span>
                  ) : (
                    <button type="button" className="chat-older-pill chat-jump-start" onClick={() => void jumpToStart()}>
                      <ArrowUpOutlined /> Jump to the beginning
                    </button>
                  )}
                </div>
              )}
              {placeholder === 'queued' && showQueuedNotice && (
                dshQueueRepair ? <DshRepairCard repair={dshQueueRepair} help={authErrorHelp} /> : antigravityQueueRepair ? <AntigravityRepairCard repair={antigravityQueueRepair} help={authErrorHelp} /> : <div className="chat-queued-state">
                  <div className="chat-queued-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="chat-queued-title">{queuedTitle(selectedSession ?? selected)}</div>
                  <div className="chat-queued-desc">{slotWaitDescription}</div>
                </div>
              )}
              {placeholder === 'starting' && showStartingNotice && (
                <div className="chat-queued-state">
                  <div className="chat-queued-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="chat-queued-title">
                    {startingTitle(selectedStartingSession)}
                    <WaitElapsed since={selectedWaiting?.since} />
                  </div>
                  <div className="chat-queued-desc">{startingDescription(selectedStartingSession)}</div>
                </div>
              )}
              {/* An unvisited session's history is still in flight: hold the shape of a
                  conversation instead of a blank pane. */}
              {placeholder === 'skeleton' && <TranscriptSkeleton />}
              <SessionNavCtx.Provider value={(rawId) => navigate(`/sessions/${encodeId(rawId)}`)}>
                <EventFullCtx.Provider value={fetchEventFull}>
                  <AuthErrorCtx.Provider value={authErrorHelp}>
                    <AutoRetryCtx.Provider value={autoRetryHelp}>
                      <UndeliveredCtx.Provider value={restoreUndelivered}>
                        <LiveToolOutputsCtx.Provider value={scopedLiveToolOutputs}>
                          <TaskActivityCtx.Provider value={taskActivity}>
                          <StreamingDraftsCtx.Provider value={streamingDrafts}>
                            {/* The links in this conversation, drawn as cards. The provider is
                                what makes a card possible at all — the shared page and the export
                                mount none — and it re-reads the links when the detail above is
                                re-read, which is the only clock this view has. */}
                            <OrbitLinkCardsProvider
                              stateWord={orbitLinkStateWord}
                              refreshKey={sessionDetailQ.dataUpdatedAt}
                            >
                              <Transcript
                                events={transcriptEvents}
                                live={live}
                                turnImages={turnImages}
                                artifactSessionId={selectedId}
                                streamingAfterSeq={streamingDrafts ? streamAnchorRef.current : null}
                                inserts={transcriptInserts}
                              />
                            </OrbitLinkCardsProvider>
                          </StreamingDraftsCtx.Provider>
                          </TaskActivityCtx.Provider>
                        </LiveToolOutputsCtx.Provider>
                      </UndeliveredCtx.Provider>
                    </AutoRetryCtx.Provider>
                  </AuthErrorCtx.Provider>
                </EventFullCtx.Provider>
              </SessionNavCtx.Provider>
              {/* The delivered card, in the conversation it was delivered to and scrolling with
                  it: the server's own ask about this project's ruler. Its content is re-derived on
                  every render — the frame keeps the proposal's address and nothing else — so a
                  proposal answered in another window goes stale here rather than staying pressable
                  or silently vanishing mid-read. Keyed by the session, because this view outlives
                  navigation and those addresses belong to the conversation they were shown in:
                  unkeyed, the ones shown in one project's conversation are looked up in the next
                  project's read, found nowhere, and drawn there as proposals already answered. */}
              {selected && !selectedTrashed && (
                <SessionCriteriaDecisionCard
                  key={selectedId}
                  projectId={coordinatedProjectId}
                  onDecided={(result) =>
                    setCriteriaReplies((previous) => ({
                      ...previous,
                      [result.intentId]: result.reply ?? null,
                    }))
                  }
                />
              )}
              {/* The merge this project is asking its owner to make, drawn in the conversation that
                  is coordinating it (mock 4, §3.3): what would land on main, what the checks came
                  to, and — while it is under way — why nobody is being asked to press anything yet.
                  Read from the candidate itself rather than from any turn, so it is the same card
                  the project page shows.
                  ASKING, NOT RECORDING: what already has a moment is drawn at that moment instead —
                  a merge as its receipt (`mergedPromotions` above), a candidate a check blocked as
                  the card itself (`blockedPromotionCard` above) — rather than kept here under
                  everything that came afterwards. Keyed apart from its siblings for the reason the
                  evidence card's note gives below. */}
              {selected && selectedId && !selectedTrashed && (
                <ProjectPromotion
                  key={`promotion:${selectedId}`}
                  projectId={coordinatedProjectId}
                  drawRecords={false}
                  onChat={chatAboutThis}
                />
              )}
              {/* A question THIS conversation put to the account owner, drawn where it was asked
                  (mock 5, §5.2): the coordinator asks and goes on working, and the card is what the
                  owner answers — so the conversation shows what it is waiting on rather than only
                  the sentence it wrote when it asked. Drawn from the open items and not from any
                  turn, so it is the same card the project page shows, and it goes when it is
                  answered. Keyed apart from its siblings for the reason the evidence card's note
                  gives below. */}
              {selected && selectedId && !selectedTrashed && (
                <CoordinatorQuestions
                  key={`coordinator-question:${selectedId}`}
                  projectId={coordinatedProjectId}
                />
              )}
              {/* The same kind of card for the evidence this session may confirm or send back:
                  drawn from the pending read and pressed straight at the decision door. Keyed by
                  the session because this view outlives navigation and the card remembers which
                  versions it has shown — those belong to this conversation, not the next one. Not
                  by the bare session id, though: the criteria card above is its sibling and has
                  that key, and React loses the first of two siblings sharing a key on every render
                  without removing its DOM — copies of that card that never re-derive, stay
                  pressable after the answer, and are left behind in the pane New session reuses. */}
              {selected && selectedId && !selectedTrashed && (
                <SessionEvidenceDecisionCard
                  key={`evidence:${selectedId}`}
                  sessionId={selectedId}
                  projectId={selectedSession?.projectId ?? null}
                  onSendBack={startEvidenceSendBack}
                />
              )}
              {/* An OWNER_CONFIRMED task's confirmation card, in the task's own session — in any
                  project or none — once a run of it has ended its turn: the one place the owner
                  confirms it done or sends it back. The list row only lights and the pinned line
                  only points here. Keyed apart from its siblings for the reason the evidence card's
                  note gives. */}
              {selected && selectedId && !selectedTrashed && (
                <SessionOwnerConfirmationCard
                  key={`owner-confirmation:${selectedId}`}
                  sessionId={selectedId}
                  taskId={selectedSession?.taskId ?? null}
                  onSendBack={startOwnerSendBack}
                />
              )}
              {/* The settlement question — whether this project's criteria, together, are what
                  done means — as whichever of its three cards is asking: "Start this project?" once
                  the coordinator asks to start it, "Confirm the new criteria?" once a started
                  project's criteria move, or the older confirmation card for a started project
                  nobody ever confirmed. Pressed straight at the start door or the confirmation
                  door. Keyed by the session like the two cards above, because whether it was
                  delivered belongs to this conversation, and by a key neither of them carries, for
                  the reason the evidence card's note gives. It reports which question is on screen
                  and still asking, and that report is what the pinned strip points at. */}
              {selected && selectedId && !selectedTrashed && (
                <SessionAcceptanceConfirmationCard
                  key={`confirmation:${selectedId}`}
                  projectId={selectedSession?.projectId ?? null}
                  onOpenQuestion={reportSettlementQuestion}
                  onChatAbout={startPlanChangeChat}
                  onViewTasks={(createdTasks.data?.total ?? 0) > 0 ? viewCreatedTasks : undefined}
                />
              )}
              {/* The other end of that question: the work filed under this project has met every
                  criterion it states and no task under it is IN_PROGRESS, so is the project done?
                  Drawn from the
                  project page's own `['project', id]` read and pressed straight at the status door
                  with the browser's credential — the one shape that door accepts from a
                  conversation. Keyed by the session, because whether it was delivered belongs to
                  this conversation, and by a key none of its siblings carries, for the reason the
                  evidence card's note above gives. */}
              {selected && selectedId && !selectedTrashed && (
                <SessionProjectSettlementCard
                  key={`settlement:${selectedId}`}
                  projectId={selectedSession?.projectId ?? null}
                  coordinator={
                    selectedSession?.projectMembership?.role === undefined
                      || selectedSession?.projectMembership?.role === 'COORDINATOR'
                  }
                  waitingKind={selectedSession?.waitingKind ?? null}
                  onDelegate={delegateProjectSettlement}
                />
              )}
              {selected &&
                !selectedTrashed &&
                showQueuedNotice &&
                transcriptEvents.length > 0 && (
                dshQueueRepair ? <DshRepairCard repair={dshQueueRepair} help={authErrorHelp} /> : antigravityQueueRepair ? <AntigravityRepairCard repair={antigravityQueueRepair} help={authErrorHelp} /> : <div className="chat-note chat-slot-wait">
                  <span>{queuedTitle(selectedSession ?? selected)}</span>
                  <span>{slotWaitDescription}</span>
                </div>
              )}
              {selected &&
                !selectedTrashed &&
                showStartingNotice &&
                transcriptEvents.length > 0 && (
                <div className="chat-note chat-slot-wait">
                  <span>
                    {startingTitle(selectedStartingSession)}
                    <WaitElapsed since={selectedWaiting?.since} />
                  </span>
                  <span>{startingDescription(selectedStartingSession)}</span>
                </div>
              )}
              {localStatusCards.map((card) => (
                <SessionStatusCard card={card} key={card.id} />
              ))}
              {/* The live drafts used to render here, after everything. They render inside the
                  transcript now, at the seq the stretch began — see StreamingDraftsCtx. */}
              {!selectedTrashed && approvals.map((a) => (
                // Only the first (oldest) still-answerable approval with a shortcut owns Enter;
                // once it's decided the next one becomes first, so the key walks the queue in
                // order — stepping over any card whose question is already over.
                <ApprovalPanel
                  key={a.id}
                  approval={a}
                  onDecide={decide}
                  active={a.id === activeApprovalId}
                  answerable={answerableApprovalIds.has(a.id)}
                  onChatAbout={startChatReply}
                  onDecline={startDeclineReply}
                />
              ))}
              {!selectedTrashed && visibleQueuedTurns.map((q) => {
                // Another Orbit session's message is asked about FIRST, off the card the snapshot
                // carried, before anything is read out of its words — which are the sending agent's to
                // choose, and could take the shape of a wake below (the transcript's own order,
                // NodeView).
                const fromSession = q.sessionMessage ?? null;
                // A wake a watch queued is the card the transcript draws once a runner takes it
                // (NodeView), so it keeps that shape when it lands and its JSON stays folded. How
                // its delivery stands is the queue's line to say, as for every queued row.
                const wake = fromSession ? null : parseWatchWake(q.content);
                // A wake the control plane queued for a background job's news, or for a wakeup coming
                // due, is nobody's message either: it gets the line the transcript draws once a
                // runner takes it. Withdrawing it is an ordinary cancel — nothing re-sends it.
                const background = fromSession || wake ? null : parseBackgroundWake(q.content);
                return fromSession ? (
                  // Drawn "From [that session]" while it waits, as the transcript draws it once a
                  // runner takes it. Cancel withdraws it and hands nothing back to the composer — the
                  // words are the sending session's (`returnsToComposer`) — and there is no Put back
                  // for the same reason.
                  <SessionMessageCard
                    key={q.turnId}
                    card={fromSession}
                    text={q.content}
                    ts={q.createdAt}
                    queued={
                      <QueuedTurnMeta
                        placement={q.placement}
                        delivery={q.delivery}
                        deliveryCode={q.deliveryCode}
                        deliveryReason={q.deliveryReason}
                        onCancel={() => cancelQueued(q.turnId)}
                      />
                    }
                  />
                ) : wake ? (
                  <WatchWakeCard
                    key={q.turnId}
                    wake={wake}
                    text={q.content}
                    linkable
                    undelivered={false}
                    queued={
                      <QueuedTurnMeta
                        placement={q.placement}
                        delivery={q.delivery}
                        deliveryCode={q.deliveryCode}
                        deliveryReason={q.deliveryReason}
                        wake
                        onCancel={() => withdrawWake(q.turnId)}
                      />
                    }
                  />
                ) : background ? (
                  <BackgroundWakeCard
                    key={q.turnId}
                    wake={background}
                    queued={
                      <QueuedTurnMeta
                        placement={q.placement}
                        delivery={q.delivery}
                        deliveryCode={q.deliveryCode}
                        deliveryReason={q.deliveryReason}
                        onCancel={() => cancelQueued(q.turnId)}
                      />
                    }
                  />
                ) : q.openItemDelivery ? (
                  // An exception item's delivery is nobody's message on the queue either, and for a
                  // stronger reason than the two wakes above: nobody typed it at all. It gets the
                  // card the transcript draws once a runner takes it, with the queue's line at its
                  // foot — so taking the turn changes nothing about how the delivery reads. Read off
                  // the payload the active snapshot carried, never out of the text's shape.
                  <OpenItemDeliveryCard
                    key={q.turnId}
                    card={q.openItemDelivery}
                    text={q.content}
                    ts={q.createdAt}
                    queued={
                      <QueuedTurnMeta
                        placement={q.placement}
                        delivery={q.delivery}
                        deliveryCode={q.deliveryCode}
                        deliveryReason={q.deliveryReason}
                        onCancel={() => cancelQueued(q.turnId)}
                        onPutBack={restoreUndelivered ? () => takeBackUndelivered(q) : undefined}
                      />
                    }
                  />
                ) : q.confirmationReviewRequest || q.confirmationReturn ? (
                  // A confirmation review's turns are Orbit's on the queue too: the card the
                  // transcript draws once a runner takes them, with the queue's line at its foot.
                  q.confirmationReviewRequest ? (
                    <ReviewRequestedCard
                      key={q.turnId}
                      card={q.confirmationReviewRequest}
                      ts={q.createdAt}
                      queued={
                        <QueuedTurnMeta
                          placement={q.placement}
                          delivery={q.delivery}
                          deliveryCode={q.deliveryCode}
                          deliveryReason={q.deliveryReason}
                          onCancel={() => cancelQueued(q.turnId)}
                        />
                      }
                    />
                  ) : (
                    <SentBackByReviewerCard
                      key={q.turnId}
                      card={q.confirmationReturn!}
                      ts={q.createdAt}
                      queued={
                        <QueuedTurnMeta
                          placement={q.placement}
                          delivery={q.delivery}
                          deliveryCode={q.deliveryCode}
                          deliveryReason={q.deliveryReason}
                          onCancel={() => cancelQueued(q.turnId)}
                        />
                      }
                    />
                  )
                ) : q.projectStarted ? (
                  // The message telling the coordinator its project was started, as the card the
                  // transcript draws once a runner takes it — the same reason as the delivery above.
                  <ProjectStartedCard
                    key={q.turnId}
                    card={q.projectStarted}
                    text={q.content}
                    ts={q.createdAt}
                    queued={
                      <QueuedTurnMeta
                        placement={q.placement}
                        delivery={q.delivery}
                        deliveryCode={q.deliveryCode}
                        deliveryReason={q.deliveryReason}
                        onCancel={() => cancelQueued(q.turnId)}
                        onPutBack={restoreUndelivered ? () => takeBackUndelivered(q) : undefined}
                      />
                    }
                  />
                ) : (
                  <div className="chat-msg chat-user chat-queued" key={q.turnId}>
                    {turnImages[q.turnId]?.length ? (
                      // Fresh local previews (object URLs) — instant, before a reload drops them.
                      <div className="chat-images">
                        {turnImages[q.turnId].map((im, i) => (
                          <ChatImage key={i} src={im.url} />
                        ))}
                      </div>
                    ) : q.attachments?.length ? (
                      // After a reload the local previews are gone; fetch the refs the queued-turn
                      // list carries from the server, so an image-only turn stays visible.
                      <div className="chat-images">
                        {q.attachments.map((a) => (
                          <AttachmentImage key={a.id} id={a.id} />
                        ))}
                      </div>
                    ) : null}
                    {/* Same Markdown render as the settled bubble it becomes (see UserBubble), so a
                        message doesn't change shape when the runner picks it up. A queued `!cmd`
                        shows the command verbatim — markdown would mangle its shell syntax. */}
                    {q.shell ? (
                      <code className="chat-queued-cmd">!{q.content}</code>
                    ) : (
                      q.content && <MD breaks>{q.content}</MD>
                    )}
                    <QueuedTurnMeta
                      placement={q.placement}
                      delivery={q.delivery}
                      deliveryCode={q.deliveryCode}
                      deliveryReason={q.deliveryReason}
                      onCancel={() => cancelQueued(q.turnId)}
                      onPutBack={restoreUndelivered ? () => takeBackUndelivered(q) : undefined}
                    />
                  </div>
                );
              })}
              {placeholder === 'waiting' && <div className="chat-note">Waiting for the workspace…</div>}
              {selected &&
                selectedTrashed &&
                (() => {
                  // Days until the reaper permanently purges this trashed session. Reframes
                  // the retained transcript as an honest, time-boxed Trash rather than a
                  // "delete that didn't delete", and offers a real permanent delete.
                  const left = selected.deletedAt
                    ? Math.max(
                        0,
                        Math.ceil(
                          (new Date(selected.deletedAt).getTime() +
                            TRASH_RETENTION_DAYS * 86_400_000 -
                            Date.now()) /
                            86_400_000,
                        ),
                      )
                    : null;
                  const when =
                    left === null
                      ? ''
                      : left <= 0
                        ? ' · deletes soon'
                        : ` · auto-deletes in ${left} day${left === 1 ? '' : 's'}`;
                  return (
                    <div className="chat-note">
                      In Trash{when}.{' '}
                      {selectedCanRestore ? (
                        <a onClick={() => requestRestore(selected)}>Restore to Open</a>
                      ) : (
                        <span title="Restore unavailable right now">Restore unavailable</span>
                      )}
                      {' · '}
                      <a onClick={() => confirmPurge({ id: selected.id, title: selected.title })}>
                        Delete permanently
                      </a>
                    </div>
                  );
                })()}
              {selected && sameSessionSendBlocked && (
                <div className="chat-note">{sameSessionSendBlockedCopy}</div>
              )}
              {selected &&
                !selectedTrashed &&
                isSessionTerminal(selectedSession ?? selected) && (
                <div className="chat-note">
                  {sessionEndedBanner(
                    selectedSession ?? selected,
                    !!resumable,
                    !!runner.online,
                    !resumable ? selectedResumeBlockedCopy : null,
                  )}
                </div>
              )}
            </div>
          ) : composing ? (
            // The provider hero is centered as a hero only while it's alone: .workspace-draft is a
            // centering flex row, so once /status prints a card it would sit beside the hero instead
            // of under it. With cards the pane falls back to plain transcript flow.
            <div
              className={`workspace-sessions${localStatusCards.length ? '' : ' workspace-draft'}`}
              ref={scrollRef}
            >
              <NewSessionProviderHero
                current={currentProviderChoiceForDraft}
                choices={providerChoicesForRunner}
                onPick={pickDraftProvider}
                currentAccount={pickedProvider === 'claude' ? shownClaudeAccount : shownCodexAccount}
                automatic={{
                  ...(codexAutoOffered ? { codex: !draftCodexAccount } : {}),
                  ...(claudeAutoOffered ? { claude: !draftClaudeAccount } : {}),
                }}
                onPickAccount={pickDraftAccount}
                runnerId={runner.id}
                currentModelLabel={shownModelLabel}
                // Nothing to choose until we know which workspace (and so which project) this runs in.
                disabled={!pickedWorkspace}
                note={providerSwitchNote}
                projectIntent={projectIntent}
              />
              {localStatusCards.map((card) => (
                <SessionStatusCard card={card} key={card.id} />
              ))}
            </div>
          ) : (
            <div className="workspace-sessions" />
          )}
          {selectedId && (
            <SessionFind
              sessionId={selectedId}
              containerRef={scrollRef}
              loadOlder={loadOlder}
              hasOlder={hasOlderNow}
              oldestSeq={oldestSeqNow}
            />
          )}
          {selectedId && detached && loadingNewer && (
            <div className="chat-newer-bottom">
              <span className="chat-older-pill">{LOADING_NEWER}</span>
            </div>
          )}
          {selectedId && (!atBottom || stranded) && (
            <button
              className="scroll-to-bottom"
              aria-label={detached ? JUMP_TO_LATEST : 'Scroll to bottom'}
              onClick={detached ? backToLatest : scrollToBottom}
            >
              <ArrowDownOutlined />
            </button>
          )}
        </div>

      <div className="workspace-composer">
        {/* What this session is waiting on: live watches it observes. A watch waits on the server,
            not in a process, so it gets its own strip rather than a row in the tray below
            (docs/watch-contract.md §9.2). Hidden when there are none. */}
        {selectedId && !selectedTrashed && <SessionWatchStrip sessionId={selectedId} />}
        {/* Background processes the workspace launched (Bash run_in_background) — invisible
            otherwise. Derived from this session's events; hidden when there are none. */}
        {selectedId && !selectedTrashed && (
          <BackgroundShellsTray
            events={events}
            live={live}
            serverShells={serverBgShells}
            liveProgress={scopedLiveTaskProgress}
          />
        )}
        {/* The tasks this session's agent created, beside the branch below: the conversation's two
            kinds of output next to each other. Hidden until it has created one. */}
        {selectedId && !selectedTrashed && (
          <SessionCreatedTasksStrip sessionId={selectedId} openRequest={createdTasksOpenRequest} />
        )}
        <SessionOutputs
          // Only the open session has a worktree to show. With nothing selected (new-session
          // draft, empty list) `keepPreviousData` still holds the previously-open session's
          // detail, which would render its stale branch/diff bar over a fresh draft — so gate
          // on selectedId rather than the placeholder-backed query data.
          detail={selectedId && !selectedTrashed && !selectedMissing ? detailForSelected : null}
          committed={!live}
          // A turn in flight (live but not awaiting input) leaves the branch in a transient
          // state — hold "Merge to main" until it finishes so we never merge half-done work.
          turnActive={isSessionTurnActive(selected, !!live, idle)}
          enabling={enableIsoMut.isPending}
          onEnableIsolation={
            detailForSelected?.workspace?.id
              ? () => askEnableIsolation(detailForSelected.workspace!.id)
              : undefined
          }
          merging={mergeMut.isPending || repairRecoveryMut.isPending}
          onMergeToMain={
            selectedId && detailForSelected?.branch
              ? (target?: string) =>
                  mergeMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                    target,
                  })
              : undefined
          }
          onRecoverMerge={selectedId ? (recoveryAction, previewId) => mergeMut.mutate({
            id: selectedId, title: selectedSession?.title ?? 'Untitled session',
            target: detailForSelected?.mergeRecovery?.targetBranch ?? detailForSelected?.mergeTarget ?? undefined,
            recoveryAction, previewId,
          }) : undefined}
          onRepairRecovery={(preparePr) => repairRecoveryMut.mutate(preparePr)}
          repairStarting={repairRecoveryMut.isPending}
          onOpenRepair={detailForSelected?.mergeRepairSession ? () => navigate(`/sessions/${encodeId(detailForSelected.mergeRepairSession!.id)}`) : undefined}
          resolving={resolveMut.isPending}
          onResolveInSession={
            selectedId && detailForSelected?.branch
              ? (target: string) =>
                  resolveMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                    branch: detailForSelected.branch!,
                    target,
                  })
              : undefined
          }
          resolvingCommit={resolveCommitMut.isPending}
          onResolveCommitInSession={
            selectedId && detailForSelected?.branch
              ? () =>
                  resolveCommitMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                    branch: detailForSelected.branch!,
                    why: commitFailureCopy(
                      detailForSelected.commitError,
                      detailForSelected.commitResultMessage,
                    ).why,
                  })
              : undefined
          }
          committing={commitMut.isPending}
          onCommit={
            selectedId && detailForSelected?.branch
              ? () =>
                  commitMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                  })
              : undefined
          }
          adopting={adoptMut.isPending}
          onAdopt={
            selectedId
              ? () =>
                  adoptMut.mutate({
                    id: selectedId,
                    title: selectedSession?.title ?? 'Untitled session',
                  })
              : undefined
          }
          // The shared checkout behind this console. Attached to the workspace (not the session):
          // it's the machine's state, and every session here fails the same way when it's stuck.
          repoHealth={consoleWorkspaceRepoHealth}
          cleaningRepo={repoCleanupMut.isPending}
          onCleanUpRepo={
            consoleWorkspaceId && consoleWorkspaceRepoHealth
              ? () => askCleanUpRepo(consoleWorkspaceId, consoleWorkspaceRepoHealth.root)
              : undefined
          }
        />
        {replyTo && (
          <div className="composer-replyto">
            <span className="composer-replyto-icon">↩</span>
            <span className="composer-replyto-text">{replyTo.banner}</span>
            <button
              type="button"
              className="composer-replyto-cancel"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            >
              <CloseOutlined />
            </button>
          </div>
        )}
        {projectIntent && (
          <div className="composer-project-intent" role="status">
            <b>◧ This will create a new project</b>
            <span>— Describe the outcome you want; Orbit will read the repository before working out the plan with you</span>
            <button
              type="button"
              className="composer-project-intent-close"
              onClick={dismissProjectIntent}
              aria-label="Dismiss project intent"
            >
              ✕
            </button>
          </div>
        )}
        {/* Where this task's current run is, said above the composer rather than in a toast: a
            toast is gone by the time the reader has decided what to do about it, and every one of
            these has something to decide. */}
        {handedOverTo && (
          <TaskRunHandedOverNotice
            onDismiss={() => setHandedOverTo(null)}
            sessionId={handedOverTo}
          />
        )}
        {runConflict
          && (runConflict.vars.source !== 'autoRetry'
            || runConflict.conflict.kind === 'CONFIRM_SWITCH') && (
          <TaskRunHandoffNotice conflict={runConflict.conflict} onAction={answerRunConflict} />
        )}
        {composerProviderNote && (
          <div className="composer-provider-note" role="status">
            {composerProviderNote}
          </div>
        )}
        <div className={shellMode ? 'composer-box composer-box-shell' : 'composer-box'}>
          {/* Drag to set an explicit height (overrides auto-grow); double-click to reset.
              Only shown once the box has hit its auto-grow cap or the user set a manual
              height — an empty/short composer has nothing worth resizing. */}
          {(composerHeight != null || composerCapped) && (
            <div
              className="composer-resize-handle"
              onMouseDown={startComposerResize}
              onDoubleClick={() => setComposerHeight(null)}
              title="Drag to resize · double-click to reset"
            />
          )}
          {showSlash && (
            <div className="composer-slash-menu" role="listbox">
              {slashMatches.map((it, i) => (
                <div
                  key={`${it.type}:${it.name}`}
                  role="option"
                  aria-selected={i === slashIdx}
                  className={`composer-slash-item${i === slashIdx ? ' is-active' : ''}`}
                  // mousedown (not click) + preventDefault keeps focus in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(it.name);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span className="composer-slash-name">/{it.name}</span>
                  <span className="composer-slash-type">
                    {it.type === 'skill' ? 'skill' : it.type === 'local' ? 'local' : 'cmd'}
                  </span>
                  {it.workspaceId && <span className="composer-slash-type">project</span>}
                  {it.description && <span className="composer-slash-desc">{it.description}</span>}
                </div>
              ))}
            </div>
          )}
          {showRef && (
            <div className="composer-slash-menu" role="listbox">
              {refMatches.map((m, i) => (
                <div
                  key={`${m.kind}:${m.id}`}
                  role="option"
                  aria-selected={i === refIdx}
                  className={`composer-slash-item${i === refIdx ? ' is-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickRef(m);
                  }}
                  onMouseEnter={() => setRefIndex(i)}
                >
                  <span className="composer-slash-name">#{m.title}</span>
                  <span className="composer-slash-type">{m.kind === 'list' ? 'list' : 'task'}</span>
                </div>
              ))}
            </div>
          )}
          {showMention && (
            <div className="composer-slash-menu" role="listbox">
              {mentionMatches.map((a, i) => (
                <div
                  key={a.id}
                  role="option"
                  aria-selected={i === mentionIdx}
                  className={`composer-slash-item${i === mentionIdx ? ' is-active' : ''}`}
                  // mousedown (not click) + preventDefault keeps focus in the textarea.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(a.name);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  <span className="composer-slash-name">@{a.name}</span>
                  <span className="composer-slash-type">workspace</span>
                </div>
              ))}
            </div>
          )}
          {/* Hidden picker the `Image` menu item triggers; we upload via addImage
              ourselves and reset value so re-picking the same file fires onChange again. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              Array.from(e.target.files ?? []).forEach((f) => void addImage(f));
              e.target.value = '';
            }}
          />
          {/* Hidden picker for the `File` menu item — any type (the runner routes by
              MIME: images/PDFs inline, everything else into the worktree). Same upload path. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              Array.from(e.target.files ?? []).forEach((f) => void addImage(f));
              e.target.value = '';
            }}
          />
          {/* Staged attachments sit inside the card, above the text they go out with, so a
              screenshot reads as part of the message you're about to send — not as one more strip
              of the band above, separated from the text by the watch, tray and branch bars. */}
          {images.length > 0 && (
            <div className="composer-attachments">
              {images.map((im) =>
                // An image picked here draws from its local object URL (instant); one handed back out
                // of a sent message has no blob and draws from the bytes the control plane holds.
                im.previewUrl || (im.id && im.mime.startsWith('image/')) ? (
                  <span key={im.uid} className="composer-pill composer-attach">
                    {im.previewUrl ? (
                      <Image
                        className="composer-attach-thumb"
                        src={im.previewUrl}
                        alt=""
                        preview={{ mask: <EyeOutlined className="composer-attach-eye" /> }}
                      />
                    ) : (
                      <AttachmentImage id={im.id as string} variant="chip" />
                    )}
                    {im.status === 'uploading' && (
                      <span className="composer-attach-spin">
                        <LoadingOutlined spin />
                      </span>
                    )}
                    <button
                      type="button"
                      className="composer-attach-remove"
                      onClick={() => removeImage(im.uid)}
                      aria-label="Remove image"
                    >
                      <CloseOutlined />
                    </button>
                  </span>
                ) : (
                  <span key={im.uid} className="composer-pill composer-file">
                    {im.status === 'uploading' ? (
                      <LoadingOutlined spin className="composer-file-icon" />
                    ) : (
                      <PaperClipOutlined className="composer-file-icon" />
                    )}
                    <span className="composer-file-name" title={im.name}>
                      {im.name}
                    </span>
                    {im.size !== undefined && (
                      <span className="composer-file-size">{fmtBytes(im.size)}</span>
                    )}
                    <button
                      type="button"
                      className="composer-file-remove"
                      onClick={() => removeImage(im.uid)}
                      aria-label="Remove file"
                    >
                      <CloseOutlined />
                    </button>
                  </span>
                ),
              )}
            </div>
          )}
          <div className="composer-field">
          {/* Behind the input, drawing its chips. Same characters, same metrics — see the
              `.composer-field` block in index.css for why that is not negotiable. */}
          <ComposerMirror text={text} refs={composerRefs} scrollTop={composerScroll} />
          <Input.TextArea
            ref={taRef}
            onScroll={(e) => setComposerScroll(e.currentTarget.scrollTop)}
            className={shellMode ? 'composer-shell' : undefined}
            variant="borderless"
            // Auto-grow up to 12 rows, then scroll — unless the user has dragged the handle to
            // a fixed height, which takes over (autoSize off + explicit height).
            autoSize={composerHeight == null ? { minRows: 1, maxRows: 12 } : false}
            style={composerHeight == null ? undefined : { height: composerHeight }}
            // Hard-cap input length: an oversized prompt freezes the composer (autoSize
            // remeasures the whole value on every keystroke) and the transcript. Pasting past
            // the cap truncates; very large content should go through File instead.
            maxLength={MAX_PROMPT_CHARS}
            placeholder={composerPlaceholder}
            value={text}
            disabled={composerDisabled}
            // Typing exits history recall: the next Up starts fresh from this draft.
            onChange={(e) => {
              setText(e.target.value);
              if (histIdx !== -1) setHistIdx(-1);
            }}
            // Paste a file straight from the clipboard — a screenshot, or a file copied in the
            // OS file manager (best-effort: only where the browser exposes it as a clipboard
            // file). Only swallow the paste when it carries files, so pasting text is untouched.
            onPaste={(e) => {
              if (!canAttach) return;
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file')
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                files.forEach((f) => void addImage(f));
              }
            }}
            // One keydown handler: drive the menu while open, else Up/Down recall
            // history (when it doesn't fight cursor movement), Enter=send / Shift+Enter=newline.
            onKeyDown={(e) => {
              if (showRef && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setRefIndex((i) => (i + 1) % refMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setRefIndex((i) => (i - 1 + refMatches.length) % refMatches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickRef(refMatches[refIdx]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setRefDismissed(refToken);
                  return;
                }
              }
              if (showMention && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickMention(mentionMatches[mentionIdx].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMentionDismissed(mentionToken);
                  return;
                }
              }
              if (showSlash && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickSlash(slashMatches[slashIdx].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSlashDismissed(slashToken);
                  return;
                }
              }
              // Shell-style history recall. Up only fires on the first line and Down on
              // the last line (with no text selected), so navigating within a multi-line
              // draft still moves the caret normally. After recall the caret is parked at
              // the start (Up) / end (Down) so a repeat keeps stepping through history.
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                !e.nativeEvent.isComposing &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.shiftKey
              ) {
                const ta = e.currentTarget;
                const noSelection = ta.selectionStart === ta.selectionEnd;
                const onFirstLine = !ta.value.slice(0, ta.selectionStart).includes('\n');
                const onLastLine = !ta.value.slice(ta.selectionEnd).includes('\n');
                const setCaret = (pos: number): void => {
                  // setText re-renders the textarea; restore the caret on the next tick.
                  setTimeout(() => {
                    ta.selectionStart = ta.selectionEnd = pos;
                  }, 0);
                };
                if (e.key === 'ArrowUp' && noSelection && onFirstLine) {
                  const list = loadHistory(selectedId);
                  if (list.length) {
                    e.preventDefault();
                    if (histIdx === -1) setHistDraft(text);
                    const idx = histIdx === -1 ? list.length - 1 : Math.max(0, histIdx - 1);
                    setHistIdx(idx);
                    setText(list[idx]);
                    setCaret(0);
                    return;
                  }
                }
                if (e.key === 'ArrowDown' && noSelection && onLastLine && histIdx !== -1) {
                  e.preventDefault();
                  const list = loadHistory(selectedId);
                  if (histIdx < list.length - 1) {
                    const idx = histIdx + 1;
                    setHistIdx(idx);
                    setText(list[idx]);
                    setCaret(list[idx].length);
                  } else {
                    setHistIdx(-1);
                    setText(histDraft);
                    setCaret(histDraft.length);
                  }
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // An Enter with something to send is the send's alone. The send empties the box
                // before the key reaches the window, where a waiting card answers Enter on an
                // empty field (CardHotkey) — so the same press also started a project. An Enter on
                // an empty box still goes on to the card.
                //
                // While a reply is armed the keys are this composer's, empty or not: the box is
                // where that sentence is typed, and what the press would otherwise reach is either
                // another card's door — on the chord, a READY candidate merges main
                // (`ProjectPromotionCard`) — or the arming card's own, pressed from a box the
                // reader is still composing in (the settlement card's Start the project, the
                // confirmation card's Confirm done).
                if (text.trim() || readyImages.length > 0 || replyTo) e.stopPropagation();
                onSend();
              }
            }}
          />
          </div>
          <div className="composer-toolbar">
            {/* In shell mode this stops being a menu: `trigger={[]}` makes the Dropdown an inert
                wrapper so the button below acts on its own onClick (leave shell mode) instead of
                opening the attachment menu. Nothing in that menu applies to a raw command anyway —
                and a mode you can enter needs a visible way out. */}
            <Dropdown
              trigger={shellMode ? [] : ['click']}
              placement="topLeft"
              disabled={composerDisabled}
              menu={{
                className: 'composer-attach-menu',
                // Written in the order it is DRAWN, top to bottom. This menu opens upward, so the
                // array's last entry is the one beside the `+` — while the native menu
                // (ComposerView.swift `addMenu`) hands its items to the system with the first one
                // nearest the button and gets them back reversed. Hence the native source reads
                // Command…File and this reads File…Command: both clients put Command under the
                // thumb and File at the far end, and a divider between the two groups. Pinned by
                // WorkspaceView.composerMenu.test.tsx, drawn in
                // docs/mocks/composer-attach-menu-phone.html.
                items: [
                  {
                    key: 'file',
                    icon: <PaperClipOutlined />,
                    label: 'File',
                    onClick: () => fileInputRef.current?.click(),
                  },
                  {
                    key: 'image',
                    icon: <PictureOutlined />,
                    // One word per action, the way the native composer's `+` menu writes them
                    // (ComposerView.swift `addMenu`). Offered unconditionally too: a state the
                    // upload can't work in says so on pick, rather than greying the item out.
                    label: 'Image',
                    onClick: () => imageInputRef.current?.click(),
                  },
                  { type: 'divider' },
                  {
                    key: 'shell',
                    // The terminal box, as native Shell draws it — not `ConsoleSqlOutlined`, whose
                    // SQL monitor appeared in neither client.
                    icon: <CodeOutlined />,
                    // Works on a live session, a brand-new draft (sent as the first turn), and
                    // an ended-but-resumable session (sent as the revive turn — the runner
                    // --resumes claude, runs the command, and buffers its output for the next
                    // message). Only an unresumable ended session blocks it (never started, or
                    // its runner is offline) — there's no claude context to wake.
                    label:
                      sameSessionSendBlocked || (!!selected && !live && !resumable)
                        ? 'Shell (session unavailable)'
                        : 'Shell',
                    disabled: sameSessionSendBlocked || (!!selected && !live && !resumable),
                    onClick: insertShell,
                  },
                  {
                    key: 'skill',
                    icon: <ThunderboltOutlined />,
                    label: 'Skill',
                    disabled: !runner.online || !slashItems.some((it) => it.type === 'skill'),
                    onClick: () => insertSlash('skill'),
                  },
                  {
                    key: 'command',
                    icon: <SlashCommandIcon />,
                    label: 'Command',
                    disabled: !runner.online || !slashItems.some((it) => it.type === 'command'),
                    onClick: () => insertSlash('command'),
                  },
                ],
              }}
            >
              <Button
                className={shellMode ? 'composer-attach-btn composer-shell-btn' : 'composer-attach-btn'}
                type="text"
                icon={shellMode ? undefined : <PlusOutlined />}
                onClick={shellMode ? exitShell : undefined}
                disabled={composerDisabled}
                aria-label={shellMode ? 'Leave shell mode' : 'Add attachment'}
                title={shellMode ? 'Leave shell mode' : undefined}
              >
                {shellMode ? '❯' : null}
              </Button>
            </Dropdown>
            {/* The workspace is only a Select when it can actually be picked (new, unlocked
                session); once read-only it shows as a static pill left of Model below. */}
            {!workspaceReadOnly && (
              <span className="composer-pill composer-pill-workspace">
                <Select
                  size="small"
                  variant="borderless"
                  suffixIcon={null}
                  value={shownWorkspaceId}
                  onChange={setWorkspaceId}
                  options={workspacesForRunner.map((a) => ({ value: a.id, label: a.name }))}
                  placeholder="Default"
                  disabled={live || !!lockedWorkspaceId}
                  popupMatchSelectWidth={false}
                />
              </span>
            )}
            <span className="composer-pill">
              <Select
                size="small"
                variant="borderless"
                suffixIcon={null}
                value={shownMode}
                onChange={(v) => {
                  if (live) {
                    configMut.mutate({ permissionMode: MODE_TO_PERMISSION[v] });
                  } else {
                    modeSeedState.current = dirtyContextSeed(modelContextKey);
                    setMode(v);
                  }
                }}
                options={MODE_OPTIONS.map((m) => {
                  // A mode this ENGINE cannot honor is still offered, and never disabled: it is the
                  // user's stored intent, and it starts being enforced the moment the session moves
                  // to an engine that can — it just must not read as a guarantee it isn't, so the
                  // option carries the caveat. The wording comes from the shared table rather than
                  // being rebuilt here: a picker that re-derives it is a picker that can contradict
                  // what dispatch will do.
                  //
                  // A mode this RUNNER cannot run is the one exception, and disabled rather than
                  // annotated, because the premise above does not hold for it: a session cannot move
                  // to another machine, so Bypass on a root runner is not a mode awaiting its moment
                  // — claude exits during startup and the session never produces anything. Disabled
                  // and not hidden, so the reason is visible instead of the option silently missing.
                  //
                  // A mode the RUNTIME refuses outright (DeepSeek Harness outside Default, Auto and
                  // Don't Ask) is disabled for the same reason: the server rejects the session rather
                  // than run it as something else, so it is not an intent that can wait.
                  const semantics = permissionSemanticsFor(m);
                  const runnable =
                    permissionModeAvailableOnRunner(MODE_TO_PERMISSION[m], runner.runsAsRoot) &&
                    permissionModeSupported(MODE_TO_PERMISSION[m], shownProvider, configuredProviders);
                  const shortNote = semantics?.shortNote;
                  return {
                    value: m,
                    label: shortNote ? `${m} — ${shortNote}` : m,
                    disabled: !runnable,
                  };
                })}
                disabled={!configEditable}
                popupMatchSelectWidth={false}
              />
            </span>
            <span className="composer-pill-spacer" />
            {/* Provider, model, effort and — on a model with a fast lane — speed are one control, the
                way a reference composer writes "model · effort" as one button: the model in the
                label's colour, the effort after it in the secondary one. The menu behind it
                (`modelMenuItems`) keeps each field's own rules. */}
            <span className="composer-pill composer-model-pill">
              <Dropdown
                trigger={['click']}
                placement="topRight"
                disabled={!configEditable}
                // Rows that open a level down open on hover where the pointer can hover, the way
                // the browser's own menus do — and on a tap where it cannot, because a phone has
                // no hover to give: one row, two gestures, decided by the pointer.
                // They open to the right — and on a phone, where the control sits near the
                // right edge, there is no right: shift the level back inside the screen rather
                // than let it hang off the edge (and widen the page with it).
                menu={{
                  className: 'composer-model-menu',
                  items: modelMenuItems,
                  triggerSubMenuAction: canHover ? 'hover' : 'click',
                  builtinPlacements: {
                    rightTop: {
                      points: ['tl', 'tr'],
                      overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true },
                    },
                  },
                }}
              >
                <button
                  type="button"
                  className={`composer-model-chip${smartRoute ? ' is-smart' : ''}`}
                  disabled={!configEditable}
                  aria-label={`Model ${shownModelLabel}, effort ${shownEffortLabel}${
                    smartRoute ? ', picked by smart selection' : ''
                  }`}
                >
                  {smartRoute && (
                    <span className="composer-model-spark" aria-hidden="true">
                      ✦
                    </span>
                  )}
                  <span className="composer-model-name">{shownModelLabel}</span>
                  <span className="composer-model-effort">
                    {fastModeUsable && shownFastMode ? `${shownEffortLabel} · Fast` : shownEffortLabel}
                  </span>
                </button>
              </Dropdown>
            </span>
            {shownPool && shownPoolAccount && (
              <Tooltip title={poolAccountHelp(shownPool, shownPoolAccount)}>
                <span className="composer-pill composer-account" data-pool-account={shownPoolAccount.member.id}>
                  <span className="composer-account-name">{shownPoolAccount.member.label}</span>
                </span>
              </Tooltip>
            )}
            {shownPlanUsage && (
              <PlanUsageIndicator
                usage={shownPlanUsage}
                // Which of the runner's Codex or Claude accounts this quota is, named inside the popover
                // rather than beside the gauge, where a phone's toolbar has no room for an email. A
                // draft names the one it would start on.
                account={
                  shownAccountEngine && shownAccountLabel
                    ? {
                        label: shownAccountLabel,
                        ...(!selectedId &&
                        !(shownAccountEngine === 'claude' ? draftClaudeAccount : draftCodexAccount) &&
                        automaticOfferedOn(shownAccountEngine, pickedWorkspace)
                          ? { note: 'Automatic — the account whose quota resets soonest' }
                          : selectedId && sessionAutomatic && accountsOffered
                            ? { note: 'Automatic — moves to another account when this one hits its limit' }
                            : {}),
                      }
                    : undefined
                }
                // Earned reset credits belong to the runner's own Codex sign-in, so only a session on
                // the built-in Codex runtime is offered them — on Default, whose quota this then is;
                // the create route judges the workspace.
                reset={
                  shownProvider === 'codex' && shownCodexAccount === 'default'
                    ? { runner, workspaceId: shownWorkspaceId }
                    : undefined
                }
              />
            )}
            {/* Context stays visible even before the first turn reports tokens — a New Session reads
                "—". Rightmost pill, to the right of plan usage. */}
            {!(shownProvider === 'opencode' && shownModel === '') && (
              <ContextWindowIndicator
                tokens={contextTokens}
                reportedWindow={reportedContextWindow}
                model={shownModel}
                provider={shownProvider}
                modelCatalog={runner.modelCatalog}
                configured={configuredProviders}
              />
            )}
            {showStop ? (
              <Button
                className="composer-send"
                type="primary"
                shape="circle"
                icon={<StopSquareIcon />}
                onClick={() => selected && control.mutate(selected.id)}
                aria-label="Stop"
              />
            ) : (
              <Button
                className="composer-send"
                type="primary"
                shape="circle"
                icon={<ArrowUpOutlined />}
                disabled={!canSend}
                loading={send.isPending}
                onClick={() => onSend()}
                aria-label={defaultSendIntent === 'CURRENT_WORK' ? 'Add to current work' : 'Send'}
              />
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
