# Share to Orbit — design

Status: accepted (2026-11-16): D1–D4 = A; §5 revised 2026-11-18 (criterion 5 revision 2). Board: `docs/mocks/share-to-orbit/01-board.html` (PNGs beside it).

## 1. Goal

The system share sheet on iOS, Android and macOS lists **Orbit**. When a user shares files, images, text or a
link to it, they pick a session (or *New session*), and the items show up as staged attachments in that
session's composer, the same chips the composer's own `+` menu makes. The user then adds a sentence and
sends it from the app. Nothing is sent on their behalf.

Owner decisions (2026-11-16):

- Destination: **choose a session; the items become attachments in its composer draft**. Not a one-shot send,
  not Documents, not a task.
- Platforms: **iOS, Android, macOS**.

## 2. Today

- No platform has an inbound share target. Android's `ACTION_SEND` code only shares out (attachments,
  evidence files). iOS has one app target (`src/ios/project.yml`). The macOS app is an SPM binary that
  `src/macos/scripts/build-dmg.sh` wraps into an `.app`.
- The composer already stages attachments:
  - Apple: `ConsoleModel.attach(filename:mimeType:data:)` shows a chip at once, then uploads
    `POST /attachments[?sessionId=]` (25 MB cap, `MAX_UPLOAD_BYTES`). A draft uploads without a session,
    and `createSession` links the ids later.
  - Android: `ComposerModel.importAttachment` keeps a durable copy in the draft store (`DataKind.DRAFT`)
    and then uploads.

Share therefore needs **no server change**. It is a new way into the composer's existing attach path.

## 3. Flow

```
Share sheet ─▶ Orbit share target ─▶ picker: recent sessions + "New session"
                                      │ (optional one-line note)
                                      ▼
                         hand-off: inbox entry {target, items[], note}
                                      ▼
                     Orbit app opens that session (or a new-session draft)
                     → attach() each item → chips upload as they do today
                     → user writes / sends
```

### 3.1 iOS — Share Extension

- New target `OrbitShare` (type `app-extension`, `com.apple.share-services`) in `project.yml`. It is embedded
  in `Orbit` and shares the `OrbitKit` package. Activation rule: files, images, movies, text, URLs, at most 10 items.
- **App Group** `group.io.orbitd.app` on both targets. The extension copies each item's file (by URL, never
  read whole into memory; extensions have a ~120 MB memory ceiling) into `AppGroup/ShareInbox/<uuid>/` and
  writes `entry.json` = `{ id, createdAt, target: {sessionId}|{newIn: workspaceId}, items:[{file,name,mime,bytes}], note }`.
- **Picker data**: the app writes a small snapshot of recent open sessions (id, title, workspace, updatedAt)
  to the App Group whenever its session list loads. The extension reads it, so the extension needs **no
  token and makes no network call** (decision D2).
- **Getting back to the app**: an extension cannot open its containing app through a supported API. After
  *Add*, the extension first opens Orbit on `orbit-session://<id>?share=<entryId>` the way other share
  extensions do: it walks the responder chain to `UIApplication` and calls `open(_:options:completionHandler:)`
  (owner request, 2026-11-22). Apple can close that path in any release, so when it fails the extension posts a local notification ("2 files ready in "Fix login redirect" — tap to finish"),
  which deep-links `orbit-session://<id>?share=<entryId>`. Opening Orbit any other way within 10 minutes also routes to
  the newest unconsumed entry. Notification permission already exists for push. If it is denied, the
  extension's done state says "Open Orbit to finish".
- **App side**: `ShareInbox` (OrbitKit, platform-neutral, unit-tested on Linux) lists, claims and deletes
  entries. The app's scene-activation hook claims an entry, opens the target console, and calls
  `attachFile(url:)` per item, which applies the existing size and type checks. The entry is deleted once
  every item is staged. Entries older than 24 h are swept.

### 3.2 Android — share activity

- `ShareActivity` (exported) with `SEND` / `SEND_MULTIPLE` intent filters for `*/*` and `text/plain`. It runs
  inside the app process with the real auth, so its picker is the live session list (same rows as the
  session list, search included), not a snapshot.
- On pick it starts `MainActivity` with the target and the content URIs, granting read permission. The
  target composer calls `importAttachment` for each URI, so the existing durable draft copy holds the grant
  only until the copy lands.
- No App Group, notification or snapshot is needed.

### 3.3 macOS — Share menu extension

- Same `OrbitShare` sources as iOS, built for macOS. `build-dmg.sh` grows an extension step: compile with
  `swiftc` against OrbitKit, assemble `Contents/PlugIns/OrbitShare.appex` (Info.plist with `NSExtension`),
  then sign the appex first with its own entitlements (sandbox + App Group `<TEAMID>.io.orbitd.app`) and
  the app after it, which keeps notarisation intact.
- Hand-off as on iOS (App Group inbox). The extension can call `NSWorkspace.open(orbit-session://…)`
  directly, so the Mac needs no notification step.
- This is the most expensive piece, because the SPM build has no extension support. It ships last (§6).

### 3.4 Text and links

- A shared URL, or text up to 2,000 characters, is put into the composer **text**. It is appended after any
  existing draft text, separated by a blank line.
- Longer text becomes a `.txt` attachment (`shared-text.txt`), as a large paste already does.
- Files and images are always attachments.

## 4. Limits and failures

| Case | Behaviour |
|---|---|
| Item over 25 MB / unsupported | Picker shows the row struck out with "Too large (max 25 MB)"; the rest still go |
| More than 10 items | Activation rule hides Orbit (iOS/macOS); Android takes the first 10 and says so |
| Signed out | iOS/macOS: no snapshot → extension says "Sign in to Orbit first"; Android: sign-in, then the picker |
| Target session deleted/ended meanwhile | App opens a new-session draft in that workspace with the items, and a toast says why |
| Upload fails in app | Existing chip failure path ("Upload failed — name") |

## 5. Security

- No shared item is sent to a session before the user sends from the app. The share extension (iOS/macOS) and
  the Android share activity make no network call and hold no credential. Staged items upload only through the
  existing composer attach path, exactly as a file picked from the composer's + menu does (owner ruling (a),
  criterion 5 revision 2, 2026-11-18). The feature needs no API server change.
- The inbox is inside the App Group container, which only Orbit's own signed targets can read. Entries are
  deleted on claim and after 24 h.
- Android passes content URIs with a one-shot read grant. Nothing is copied outside the draft store.

## 6. Phases (by cost)

1. **Android share target**: one activity, manifest filters, picker reuse, `importAttachment` hand-off.
2. **OrbitKit `ShareInbox` + session snapshot**: models, claim and sweep, unit tests.
3. **iOS Share Extension**: target, App Group entitlements (Debug + release; provisioning profile update in
   CI), picker UI, notification hand-off, app-side claim.
4. **macOS Share extension**: build-dmg extension step, signing order, notarisation check, app-side claim.

## 7. Decisions (board §5) — owner chose A for all four, 2026-11-16

- **D1 Where the session is picked**: A, inside the share sheet (recommended), or B, the share sheet only
  stores the items and the app asks on open.
- **D2 Picker data on Apple**: A, an app-written snapshot with no token in the extension (recommended), or
  B, a shared Keychain with a live fetch.
- **D3 Short text and links**: A, into the composer text (recommended), or B, always a `.txt` file.
- **D4 macOS**: A, a real Share-menu extension in phase 4 (recommended, as asked), or B, cheaper entry
  points instead (Dock-icon drop and a Services item).
