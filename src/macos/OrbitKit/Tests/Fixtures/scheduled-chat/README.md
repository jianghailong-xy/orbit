# Scheduled page chat: the real server's answers

Recorded 2026-11-27 from this branch's own apiserver (`src/apiserver/dist/main.js` built at d6fc4c1bdd) on a
throwaway PostgreSQL, seeded through the server's HTTP doors by `scripts/scheduled-chat-actual-stack/seed.mjs`
(one runner `dev-box`, workspaces `apiserver` and `web`, four schedules — two paused — and the page chat opened with
`POST /api/schedules/chat`). Nothing here is edited by hand.

| file | the read |
|---|---|
| `get-schedules-chat.json` | `GET /api/schedules/chat?timezone=Asia/Shanghai`: the open page chat and Orbit's opening |
| `post-schedules-chat.json` | `POST /api/schedules/chat {workspaceId, text}`: the chat the words went to |
| `session-rows.json` | `GET /api/sessions?view=open`: the Open list's rows, the page chat with `chatOrigin: SCHEDULE_CHAT` |
| `session-rows-since.json` | `GET /api/sessions?view=open&since=0`: the same as the clients read it, `{full, sessions, cursor}` |
| `get-schedules.json` | `GET /api/schedules`: the list whose titles the Run now card uses |

`ScheduledChatPayloadTests` decodes each into the types the Apple panel uses.
