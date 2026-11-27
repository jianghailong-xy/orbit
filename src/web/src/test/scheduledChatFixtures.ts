/**
 * The Scheduled page chat's payloads as this branch's apiserver sent them to the page (task 354CXjMVTfnhPkEoj0DhZ,
 * 2026-11-27): recorded by scripts/scheduled-chat-actual-stack/capture.mjs from a stack seeded through the server's own
 * HTTP doors (four schedules, two paused, a page chat opened with POST /api/schedules/chat), on a runner that was not
 * connected. fixture-diff.mjs holds these to the payloads it records: the same key paths and value types.
 *
 * Tests build their states from these, overriding only the fields a scenario is about.
 */

/** GET /api/schedules/chat: the account's open page chat and Orbit's opening (design §4.1). */
export const opening = {
  "sessionId": "354uOmQS3vJzlILFvhMZb",
  "opening": {
    "counts": {
      "total": 4,
      "active": 2,
      "paused": 2,
      "held": 0,
      "failing": 0
    },
    "next": {
      "scheduleId": "354uOmEYacylNMQzVpjja",
      "title": "Codex stable check",
      "at": "2026-11-27T22:00:00.000Z",
      "timezone": "Asia/Shanghai",
      "workspaceId": "354uOm64x7hnbWJR12ozw",
      "workspaceName": "apiserver",
      "schedulePublicId": "354uOmEYacylNMQzVpjja",
      "workspacePublicId": "354uOm64x7hnbWJR12ozw",
      "agentId": "354uOm64x7hnbWJR12ozw",
      "agentName": "apiserver"
    },
    "summary": "You have 4 scheduled tasks: 2 active, 2 paused, none failing.",
    "nextText": "Next: Codex stable check, tomorrow at 06:00 on apiserver.",
    "examplesLead": "Ask about them, or tell me what to change. For example:",
    "examples": [
      "Pause everything on orbit-ws04 until Monday",
      "Why did the last run take so long?",
      "Every weekday at 09:00, check a changelog and tell me what's new"
    ],
    "closing": "Moving a time, rewording what a task checks or how it reports applies at once, and you can undo it. More runs, longer runs, more access or another workspace need your Allow."
  },
  "sessionPublicId": "354uOmQS3vJzlILFvhMZb"
};

/** POST /api/schedules/chat {workspaceId, text}: the chat the words went to. */
export const openAnswer = {
  "sessionId": "354uQ18naURy3iDRicHxI",
  "created": true,
  "sessionPublicId": "354uQ18naURy3iDRicHxI"
};

/** A Scheduled chat's row in GET /api/sessions (the Open list): chatOrigin SCHEDULE_CHAT, queued on an offline runner. */
export const chatRow = {
  "id": "354uOmQS3vJzlILFvhMZb",
  "status": "PENDING",
  "title": "What runs tomorrow?",
  "createdAt": "2026-11-27T14:53:03.369Z",
  "lastTurnAt": null,
  "listedAt": "2026-11-27T14:53:03.369Z",
  "currentTurnStartedAt": null,
  "startedAt": null,
  "numTurns": 0,
  "costUsd": 0,
  "error": null,
  "endReason": null,
  "cancelRequestedAt": null,
  "runtimeSessionId": "80f188b7-c857-4821-b2c9-590402e7997d",
  "retryAt": null,
  "completedAt": null,
  "archivedAt": null,
  "deletedAt": null,
  "sessionKind": "CONVERSATION",
  "source": "user",
  "engine": "claude",
  "provider": "claude",
  "providerBuiltin": true,
  "model": null,
  "permissionMode": null,
  "codexSandboxUnavailable": false,
  "effort": null,
  "fastMode": false,
  "runSource": "MANUAL",
  "chatOrigin": "SCHEDULE_CHAT",
  "lastAssistantText": null,
  "lastToolUse": null,
  "lastUserText": null,
  "lastUserFrom": null,
  "lastUserFromOrbit": null,
  "lastUserFromExternal": null,
  "recapText": null,
  "recapAt": null,
  "mergeStatus": null,
  "sourceState": "UNBOUND",
  "sourceRefusalCode": null,
  "sourceRefusalDetail": null,
  "pinnedAt": null,
  "folderId": null,
  "shared": false,
  "hasGuests": false,
  "tags": [],
  "runningBgCount": 0,
  "runningBgJobCount": 0,
  "runningBgJobsStalled": false,
  "runningSubagentCount": 0,
  "runningSubagentTitle": null,
  "engineTurnActive": false,
  "activity": "TURN",
  "engineStartedAt": null,
  "enginePhase": null,
  "runClaimedAt": null,
  "enginePhaseSince": null,
  "workspace": {
    "id": "354uOm64x7hnbWJR12ozw",
    "name": "apiserver",
    "model": null,
    "effort": null,
    "publicId": "354uOm64x7hnbWJR12ozw"
  },
  "assignedRunnerId": "354uOm5UfX6Nx1wCvQVLh",
  "assignedRunner": {
    "id": "354uOm5UfX6Nx1wCvQVLh",
    "name": "dev-box",
    "status": "OFFLINE",
    "lastHeartbeatAt": null,
    "publicId": "354uOm5UfX6Nx1wCvQVLh"
  },
  "taskId": null,
  "taskTitle": null,
  "projectId": null,
  "projectTitle": null,
  "projectMembership": null,
  "queuedReason": "runner_offline",
  "queuedActive": null,
  "queuedLimit": null,
  "queuedHeldByJobs": null,
  "queuedRunnerUpdate": null,
  "runNowAvailable": false,
  "runNowRefusal": null,
  "queuedBurstLimit": null,
  "runningOverLimit": null,
  "runStatus": "PENDING",
  "sessionState": "QUEUED",
  "runState": "QUEUED",
  "lifecycleState": "OPEN",
  "filingState": "OPEN",
  "capabilities": {
    "canSend": true,
    "canResume": false,
    "resumeBlockedReason": "NOT_TERMINAL",
    "canComplete": true,
    "canArchive": true,
    "canRestore": false
  },
  "permissionSemantics": {
    "mode": "dontAsk",
    "unapproved": "deny",
    "approvalSupport": "full",
    "honored": true
  },
  "questionWithCoordinator": null,
  "pendingApprovals": 0,
  "waitingKind": null,
  "confirmationUnderReview": null,
  "ownerItems": [],
  "ownerRequests": [],
  "taskMoves": [],
  "awaitingReplyFrom": [],
  "owesReplyTo": [],
  "phase": "PENDING",
  "released": false,
  "lastTurnOutcome": null,
  "waitingOn": "HOLD",
  "workFinished": false,
  "publicId": "354uOmQS3vJzlILFvhMZb",
  "assignedRunnerPublicId": "354uOm5UfX6Nx1wCvQVLh",
  "taskPublicId": null,
  "projectPublicId": null,
  "folderPublicId": null,
  "agent": {
    "id": "354uOm64x7hnbWJR12ozw",
    "name": "apiserver",
    "model": null,
    "effort": null,
    "publicId": "354uOm64x7hnbWJR12ozw"
  }
};

/** The Open list as the server answers a read with `since` (lib/openListDelta): the whole list and a cursor. */
export const openList = <T,>(sessions: T[]) => ({ full: true as const, sessions, cursor: 'cursor-1' });
