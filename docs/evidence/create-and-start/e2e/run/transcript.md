2026-10-29T06:15:29.582Z  stack /var/tmp/cas-e2e; built from (see SOURCE_SHA); workspace 34oAq3xmR89F3JEnrSIe6; runner 34oAq3eTegepX0r0Ux6Lp
2026-10-29T06:15:29.603Z  conversation 34oArhfHTrQGUeUJpxnYg
2026-10-29T06:15:32.915Z  screenshot A-startNow-card-no-button.png
2026-10-29T06:15:32.915Z  PASS  A: the card forecasts "1 starts running within the minute"  — 📝 Confirm: create 1 task? | 1 starts running within the minute |  | EVIDENCE_JUDGMENT
2026-10-29T06:15:32.919Z  PASS  A: the card offers no Create and start (the task starts by itself)  — ["Create itEnter","💬 Chat about this"]
2026-10-29T06:15:33.957Z  PASS  A: task_create answered without error  — {
  "id": "34oAroGJ1zcyZLVqcP2Fn",
  "title": "E2E A: filed with startNow",
  "description": "Filed with startNow: one approval creates and starts it.\n\nE2E-DO: commit",
  "status": "OPEN",
  "ownerI
2026-10-29T06:15:33.957Z  PASS  A: its answer says the task was started at once
2026-10-29T06:15:33.982Z  PASS  A: the task has a session it started  — ["4HK4QFa6KqNW438AMZnJdg RUNNING"]
2026-10-29T06:15:34.686Z  screenshot B-create-and-start-card-with-button.png
2026-10-29T06:15:34.686Z  PASS  B: the card forecasts a manual start  — 📝 Confirm: create 1 task? | 1 needs a manual start — nothing will trigger it |  | EVIDENCE_JUDGMENT
2026-10-29T06:15:34.688Z  PASS  B: the card offers Create and start beside Create it  — ["Create itEnter","Create and start","💬 Chat about this"]
2026-10-29T06:15:35.727Z  PASS  B: task_create answered without error  — {
  "id": "34oArr2SPT8wJUaINDknP",
  "title": "E2E B: approved with Create and start",
  "description": "Filed without startNow; the owner presses Create and start.\n\nE2E-DO: commit",
  "status": "OP
2026-10-29T06:15:35.727Z  PASS  B: its answer says the task was started at once
2026-10-29T06:15:35.745Z  PASS  B: the task has a session it started  — ["4iQ9kFOYQmQ0bwkEEohPeh RUNNING"]
2026-10-29T06:15:36.435Z  screenshot C-plain-card-with-button.png
2026-10-29T06:15:37.475Z  PASS  C: task_create answered without error  — {
  "id": "34oArtonrhEAY3o3RD1eE",
  "title": "E2E C: plain Create it (control)",
  "description": "Filed without startNow; the owner presses the plain Create it.\n\nE2E-DO: commit",
  "status": "OPEN
2026-10-29T06:15:37.475Z  PASS  C: its answer says nothing about a start
2026-10-29T06:15:38.181Z  screenshot D-batch-card.png
2026-10-29T06:15:38.182Z  PASS  D: the batch card counts the startNow item as starting within the minute  — 🧩 Confirm: create 2 tasks? | 1 starts running within the minute | 1 needs a manual start — nothing will trigger it |  | TASKS — 2 INDEPENDENT TASKS
2026-10-29T06:15:38.183Z  PASS  D: the batch card has no Create and start
2026-10-29T06:15:39.224Z  PASS  D: task_create_batch answered without error  — [
  {
    "id": "34oArwYVwKf511ABe6USv",
    "title": "E2E D1: batch item with startNow",
    "description": "Batch item with startNow: the server's scan starts it within the minute.\n\nE2E-DO: commit
2026-10-29T06:16:24.494Z  PASS  D: the startNow item was started (by the scan) within the minute  — ["7FbBK7vKoE5JKlsulqP6pp AWAITING_INPUT"]
2026-10-29T06:16:24.494Z  PASS  D: the other item stays OPEN with no session
2026-10-29T06:16:25.504Z  PASS  E: startNow beside runAt is refused  — startNow cannot be combined with runAt: startNow starts the task as soon as it is created, runAt schedules its start for a set time. Pass one of them
2026-10-29T06:16:25.505Z  PASS  E: no card was raised for it
2026-10-29T06:17:35.531Z  PASS  C: a minute of schedule scans later the plain create is still OPEN, with no session and no runAt  — OPEN, sessions 0, runAt null
2026-10-29T06:17:50.577Z  A: session 4HK4QFa6KqNW438AMZnJdg AWAITING_INPUT
2026-10-29T06:17:50.577Z  B: session 4iQ9kFOYQmQ0bwkEEohPeh AWAITING_INPUT
2026-10-29T06:17:50.577Z  D1: session 7FbBK7vKoE5JKlsulqP6pp AWAITING_INPUT
2026-10-29T06:17:50.577Z  PASS  wire: A's card was filed with a due runAt  — 2026-10-29T06:15:32Z
2026-10-29T06:17:50.577Z  PASS  wire: B's card was filed with no runAt
2026-10-29T06:17:50.577Z  PASS  wire: each single-task card was filed declaring that its runner acts on Create and start
2026-10-29T06:17:50.581Z  PASS  stored: A's card forecast startingNow 1  — {"lists":[],"tasks":[{"ref":null,"title":"E2E A: filed with startNow","listId":null,"dependsOnRefs":[],"dependsOnTaskIds":[],"listPublicId":null,"dependsOnTaskPublicIds":[]}],"blocked":0,"assignees":[{"id":"34oAq3xmR89F3JEnrSIe6","name":"cas-e2e","hasRunner":true,"publicId":"34oAq3xmR89F3JEnrSIe6"}],"scheduled":0,"taskCount":1,"startingNow":1,"externalEdges":0,"internalEdges":0,"notDispatchable":0,"titlesTruncated":0,"needsManualStart":0,"awaitingProjectStart":0}
2026-10-29T06:17:50.581Z  PASS  stored: B's and C's cards forecast needsManualStart 1
2026-10-29T06:17:50.581Z  PASS  stored: the server recorded that declaration on each single-task card, and not on the batch card
2026-10-29T06:17:50.581Z  PASS  stored: every card the owner answered here is ALLOWED
2026-10-29T06:17:50.581Z  PASS  wire: the Create and start decision reached the runner as startAfterCreate: true  — ["ALLOWED","ALLOWED+start","ALLOWED","ALLOWED"]
2026-10-29T06:17:50.581Z  PASS  wire: no other decision carried a start
2026-10-29T06:17:50.581Z  PASS  wire: A's create carried the runAt its card showed
2026-10-29T06:17:50.581Z  PASS  wire: B's create carried a runAt (the owner's start)
2026-10-29T06:17:50.581Z  PASS  wire: C's create carried no runAt
2026-10-29T06:17:50.581Z  PASS  wire: exactly two immediate starts, for A and B  — ["/api/runner/tasks/34oAroGJ1zcyZLVqcP2Fn/execute 201","/api/runner/tasks/34oArr2SPT8wJUaINDknP/execute 201"]
2026-10-29T06:17:50.705Z  33/33 checks passed
