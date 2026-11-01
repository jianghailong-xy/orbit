## Loop A ticks

| tick | due_at | state | turn | delivered_at | delivered − due | window |
| ---: | --- | --- | ---: | --- | ---: | --- |
| 1 | 21:10:00.038Z | DELIVERED | 2 | 21:10:02.841Z | 2.8 s | before |
| 2 | 21:15:00.038Z | DELIVERED | 3 | 21:15:03.164Z | 3.1 s | before |
| 3 | 21:20:00.038Z | DELIVERED | 4 | 21:20:03.586Z | 3.5 s | before |
| 4 | 21:25:00.038Z | DELIVERED | 5 | 21:25:03.950Z | 3.9 s | before |
| 5 | 21:30:00.038Z | DELIVERED | 6 | 21:30:04.937Z | 4.9 s | before |
| 6 | 21:35:00.038Z | DELIVERED | 7 | 21:35:00.234Z | 0.2 s | before |
| 7 | 21:40:00.038Z | DELIVERED | 9 | 21:40:00.479Z | 0.4 s | before |
| 8 | 21:45:00.038Z | DELIVERED | 10 | 21:45:01.049Z | 1.0 s | before |
| 9 | 21:50:00.038Z | DELIVERED | 11 | 21:50:01.713Z | 1.7 s | before |
| 10 | 21:55:00.038Z | DELIVERED | 12 | 21:55:04.595Z | 4.6 s | before |
| 11 | 22:00:00.038Z | DELIVERED | 13 | 22:00:00.658Z | 0.6 s | before |
| 12 | 22:05:00.038Z | DELIVERED | 14 | 22:05:01.328Z | 1.3 s | before |
| 13 | 22:10:00.038Z | DELIVERED | 15 | 22:10:01.540Z | 1.5 s | before |
| 14 | 22:15:00.038Z | DELIVERED | 16 (shared) | 22:37:31.440Z | 1351.4 s | runner down |
| 15 | 22:20:00.038Z | DELIVERED | 16 (shared) | 22:37:31.440Z | 1051.4 s | runner down |
| 16 | 22:25:00.038Z | DELIVERED | 16 (shared) | 22:37:31.440Z | 751.4 s | runner down |
| 17 | 22:30:00.038Z | DELIVERED | 16 (shared) | 22:37:31.440Z | 451.4 s | runner down |
| 18 | 22:35:00.038Z | DELIVERED | 16 (shared) | 22:37:31.440Z | 151.4 s | runner down |
| 19 | 22:40:00.038Z | DELIVERED | 17 | 22:40:03.213Z | 3.2 s | after |
| 20 | 22:45:00.038Z | DELIVERED | 18 | 22:45:03.413Z | 3.4 s | after |
| 21 | 22:50:00.038Z | DELIVERED | 19 | 22:50:03.585Z | 3.5 s | after |
| 22 | 22:55:00.038Z | DELIVERED | 20 | 22:55:03.842Z | 3.8 s | after |
| 23 | 23:00:00.038Z | DELIVERED | 21 | 23:00:04.026Z | 4.0 s | after |
| 24 | 23:05:00.038Z | DELIVERED | 22 | 23:05:04.831Z | 4.8 s | after |
| 25 | 23:10:00.038Z | CANCELLED | — | — | — | after |

## Stall wakes of session A

[
  {
    "job": "bgj_9ad4f310ca2d",
    "at": "2026-10-31T21:37:30.185+00:00",
    "afterStartSeconds": 1800.2,
    "elapsedMs": 1800000,
    "idleMs": 1800000,
    "status": "running"
  }
]

## Stall wakes of session C

[
  {
    "job": "bgj_4c86a2f98e3b",
    "at": "2026-10-31T21:37:59.95+00:00",
    "afterStartSeconds": 1801.0,
    "elapsedMs": 1800000,
    "idleMs": 1800000,
    "status": "running"
  }
]

## session_get A1

```json
{
  "status": "PENDING",
  "wakeups": {
    "next": {
      "dueAt": "2026-10-31T22:35:00.038Z",
      "kind": "LOOP_TICK",
      "reason": "LRL drill loop A"
    },
    "lastFiredAt": "2026-10-31T22:10:01.541Z",
    "loop": {
      "state": "ACTIVE",
      "everySeconds": 300,
      "until": "2026-11-01T01:07:30.000Z",
      "nextDueAt": "2026-10-31T22:35:00.038Z",
      "lastFiredAt": "2026-10-31T22:10:01.541Z",
      "ticksFired": 14,
      "ticksMissed": 3,
      "endedReason": null,
      "endedAt": null
    }
  },
  "dueWhileDownSoFar": 4,
  "missedBeforeTheKill": 0,
  "minutesDownSoFar": 21.0
}
```

## session_get A2

```json
{
  "status": "AWAITING_INPUT",
  "wakeups": {
    "next": {
      "dueAt": "2026-10-31T22:45:00.038Z",
      "kind": "LOOP_TICK",
      "reason": "LRL drill loop A"
    },
    "lastFiredAt": "2026-10-31T22:40:03.214Z",
    "loop": {
      "state": "ACTIVE",
      "everySeconds": 300,
      "until": "2026-11-01T01:07:30.000Z",
      "nextDueAt": "2026-10-31T22:45:00.038Z",
      "lastFiredAt": "2026-10-31T22:40:03.214Z",
      "ticksFired": 15,
      "ticksMissed": 4,
      "endedReason": null,
      "endedAt": null
    }
  }
}
```

## Loop B ticks

| tick | due_at | state | turn | delivered_at | delivered − due | window |
| ---: | --- | --- | ---: | --- | ---: | --- |
| 1 | 21:10:29.918Z | DELIVERED | 2 | 21:10:32.855Z | 2.9 s | before |
| 2 | 21:11:29.918Z | DELIVERED | 3 | 21:11:32.920Z | 3.0 s | before |
| 3 | 21:12:29.918Z | DELIVERED | 4 | 21:12:32.989Z | 3.1 s | before |
| 4 | 21:13:29.918Z | DELIVERED | 5 | 21:13:33.049Z | 3.1 s | before |
| 5 | 21:14:29.918Z | DELIVERED | 6 | 21:14:33.121Z | 3.2 s | before |
| 6 | 21:15:29.918Z | DELIVERED | 7 | 21:15:33.188Z | 3.3 s | before |
| 7 | 21:16:29.918Z | DELIVERED | 8 | 21:16:33.253Z | 3.3 s | before |
| 8 | 21:17:29.918Z | DELIVERED | 9 | 21:17:33.381Z | 3.5 s | before |
| 9 | 21:18:29.918Z | DELIVERED | 10 | — | — | runner down |
| 10 | 21:19:29.918Z | DROPPED | — | — | — | runner down |
| 11 | 21:20:29.918Z | DROPPED | — | — | — | runner down |
| 12 | 21:21:29.918Z | DROPPED | — | — | — | runner down |
| 13 | 21:22:29.918Z | DROPPED | — | — | — | runner down |
| 14 | 21:23:29.918Z | DROPPED | — | — | — | runner down |
| 15 | 21:24:29.918Z | DROPPED | — | — | — | runner down |
| 16 | 21:25:29.918Z | DROPPED | — | — | — | runner down |
| 17 | 21:26:29.918Z | DROPPED | — | — | — | runner down |
| 18 | 21:27:29.918Z | DROPPED | — | — | — | runner down |
| 19 | 21:28:29.918Z | DROPPED | — | — | — | runner down |
| 20 | 21:29:29.918Z | DROPPED | — | — | — | runner down |
| 21 | 21:30:29.918Z | DROPPED | — | — | — | runner down |
| 22 | 21:31:29.918Z | DROPPED | — | — | — | runner down |
| 23 | 21:32:29.918Z | DROPPED | — | — | — | runner down |
| 24 | 21:33:29.918Z | DROPPED | — | — | — | runner down |
| 25 | 21:34:29.918Z | DROPPED | — | — | — | runner down |
| 26 | 21:35:29.918Z | DROPPED | — | — | — | runner down |
| 27 | 21:36:29.918Z | DROPPED | — | — | — | runner down |
| 28 | 21:37:29.918Z | DROPPED | — | — | — | runner down |
| 29 | 21:38:29.918Z | DROPPED | — | — | — | runner down |
| 30 | 21:39:29.918Z | DROPPED | — | — | — | runner down |
| 31 | 21:40:29.918Z | DROPPED | — | — | — | runner down |
| 32 | 21:41:29.918Z | DROPPED | — | — | — | runner down |
| 33 | 21:42:29.918Z | DROPPED | — | — | — | runner down |
| 34 | 21:43:29.918Z | DROPPED | — | — | — | runner down |
| 35 | 21:44:29.918Z | DROPPED | — | — | — | runner down |
| 36 | 21:45:29.918Z | DROPPED | — | — | — | runner down |
| 37 | 21:46:29.918Z | DROPPED | — | — | — | runner down |
| 38 | 21:47:29.918Z | DROPPED | — | — | — | runner down |
| 39 | 21:48:29.918Z | DROPPED | — | — | — | runner down |
| 40 | 21:49:29.918Z | DROPPED | — | — | — | runner down |
| 41 | 21:50:29.918Z | DROPPED | — | — | — | runner down |
| 42 | 21:51:29.918Z | DROPPED | — | — | — | runner down |
| 43 | 21:52:29.918Z | DROPPED | — | — | — | runner down |
| 44 | 21:53:29.918Z | DELIVERED | 11 | 21:53:32.914Z | 3.0 s | after |
| 45 | 21:54:29.918Z | DELIVERED | 12 | 21:54:32.056Z | 2.1 s | after |
| 46 | 21:55:29.918Z | DELIVERED | 13 | 21:55:33.226Z | 3.3 s | after |
| 47 | 21:56:29.918Z | DELIVERED | 14 | 21:56:33.263Z | 3.3 s | after |
| 48 | 21:57:29.918Z | DELIVERED | 15 | 21:57:33.318Z | 3.4 s | after |
| 49 | 21:58:29.918Z | DELIVERED | 16 | 21:58:30.717Z | 0.8 s | after |
| 50 | 21:59:29.918Z | CANCELLED | — | — | — | after |

## Session B status changes (samples every 10 s)

```json
[]
```

