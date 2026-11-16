# Prompt optimizer

DeepSeek improves the owner's draft in the composer before it is sent. The board is
`docs/mocks/prompt-optimizer/01-board.html` (and its `.png`). The owner approved it with every
recommendation on 2026-11-15 ("As suggested").

## Decisions

- **Composer button, preview first.** With the account switch on, the composer shows **✦ Optimize**
  (board frame 2) as a 32px ✦ icon beside Send, named by its tooltip and accessible label. The owner
  changed it from the board's labelled pill on 2026-11-16: that pill came and went with the draft and
  moved every toolbar control to its left. The result is a card above the composer (frame 4). The input box changes only when
  the owner presses **Use** or **Edit, then use**. Nothing is sent until they press Send. Send never
  waits for the optimizer.
- **On by default** (the owner's decision of 2026-11-16; it shipped off by default). The switch is
  `User.preferences.promptOptimizer`: absent means on, and turning it off writes `false`, the only
  value that reads off — the same reading as Suggested replies. It lives in
  Settings › General › Composer, under Suggested replies. Without the server's `DEEPSEEK_API_KEY` it is
  drawn disabled with the notice from frame 1b.
- **D1 A: context is what the server already holds.** One DeepSeek call per press, with no runner
  round-trip. The call reads the draft, the session's recap, its last turns (user and assistant text,
  fitted to `RECAP_INPUT_TOKEN_BUDGET` with `fitRecapActivity`), the workspace name, the Orbit
  project's goal and acceptance criteria when the session belongs to one, and up to three wiki entries
  (title and summary) that the wiki search finds for the draft in the session's workspace.
- **D2 A: the agent language when Translation is on.** With the owner's Translation on, the optimizer
  writes the agent language (Settings › Translation's "Agents work in", `preferences.translationAgentLanguage`,
  English by default) and `language` is that code. It also returns a reading copy (`gloss`) in the owner's
  language, in the same call; when the two languages are the same nothing is translated, so there is no
  gloss and the prompt is in the draft's own language, as with Translation off. With a gloss, the
  owner reads and writes their own language throughout: the card opens on the gloss, with "The agent
  receives the <language> version." under it, and its "Show in <language>" flips to the agent-language
  prompt. Use puts the gloss in the box. A send whose text is still exactly the inserted gloss carries
  `optimizedTranslation` (the agent-language prompt): it is held as any translated message is and
  released with that text, with no translator call, so the transcript shows the owner's words and
  "Show translation" shows what the agent got. With no gloss, Use inserts the prompt and an unedited
  send carries `skipTranslation: true`, so it goes as written. Once the owner edits the text, neither
  is sent and the send is translated as usual. A translation keeps text that is already in the agent
  language unchanged.
- **D3 A: the card above the composer.** Text added from context is tinted. Actions are Use, Edit then
  use, Try again, and × / Esc (dismiss, draft kept). Tab in the composer box is Use on web and Mac (the
  key that takes a reply suggestion; board docs/mocks/prompt-optimizer-use-key). After Use, an "Undo" toast (and ⌘Z in the box)
  restores the owner's draft. On the phone the card is a sheet over the composer with the same actions.

## Wire contract (`src/shared/src/prompt-optimizer.ts`)

- `GET /users/me` gains `promptOptimizerAvailable: boolean` (the server holds a DeepSeek key).
  `preferences.promptOptimizer?: boolean` is read and written through the existing
  `PATCH /users/me/preferences`.
- `POST /prompt-optimizations`, body:
  `{ draft: string; sessionId?: string; workspaceId?: string; projectId?: string }`. A session
  supplies its own workspace and project. A brand-new draft has no session yet, so it passes the
  workspace (and project) the composer has picked. The draft may hold at most 8,000 characters.
- `200` answers `PromptOptimization`:
  - `segments: { text: string; added: boolean }[]`. Concatenated, they are the optimized prompt;
    `added` marks text drawn from context, which the card tints.
  - `text: string`, the concatenation, for clients that do not tint.
  - `language: 'en' | TranslationLanguage`. It is `'en'` exactly when the owner's Translation is on;
    otherwise it is the draft's own language.
  - `gloss?: string`, present only when `language` is `'en'` and Translation is on: the same prompt in
    the owner's language, for reading.
  - `contextUsed`: a list of
    `{ kind: 'TURNS', count } | { kind: 'RECAP' } | { kind: 'PROJECT', title } | { kind: 'WIKI', count } | { kind: 'WORKSPACE', name }`,
    which the card renders as "Used: …" chips.
- Refusals:
  - `409 { code: 'PROMPT_OPTIMIZER_OFF' }` when the switch is off or the server has no key.
  - `404` for a session, workspace or project the caller does not own.
  - `400` for an empty or oversized draft.
  - `422 { code: 'PROMPT_OPTIMIZATION_FAILED', reason }`, where `reason` is one of `TIMEOUT`
    (20 s, as for a translation), `HTTP`, `NETWORK`, `EMPTY`, `TRUNCATED` or `MALFORMED`. Frame 6
    shows it as "Couldn't optimize this draft · Try again".
- Sends (`POST /sessions/:id/turns`, a new session's opening message, and a revive) accept
  `skipTranslation?: boolean` and `optimizedTranslation?: string` (D2). A turn sent with
  `skipTranslation` is never held and carries no `translation`. Under the owner's Translation, a turn sent
  with `optimizedTranslation` is held as usual and released (DONE) with that text instead of a translator
  call; a later Retry translates as usual. Anything but a string is a 400. Ignored with Translation off.
- The model is asked for JSON (`deepSeekCall` with `json: true`). A reply that does not parse, or has
  no segments, is `MALFORMED`. Code spans and URLs in the draft are protected with
  `protectVerbatim` / `restoreVerbatim` (sessions/translation.ts), as a translation does. Concurrency
  is capped per apiserver with an `AsyncWorkQueue` of 4.
- The model is told to clarify the request, keep the owner's intent and every concrete detail, add
  only facts that the context supports, never invent file paths, and answer as the owner speaking to
  the agent. It must not answer the request itself.

## Clients

Web, iOS/macOS (OrbitKit) and Android draw board frames 1–6. Android follows iOS for anything the
board leaves open. Each client keeps the button in its slot whenever the switch is on, and disabled when the box is
empty, in shell mode, and for a draft that is only a `/command`; busy, a spinner takes the same slot, so
the toolbar never shifts. The web shortcut is ⌘⇧O / Ctrl⇧O.
