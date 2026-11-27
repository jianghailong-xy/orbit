import Foundation

/// The Drive chat's words on iOS and macOS: the web's (src/web/src/lib/driveChat.ts, driveChanges.ts; the shared
/// `DRIVE_CHAT_COPY`), word for word — `DriveChatCopyParityTests` holds them to it.
public enum DriveChatCopy {
    // The panel (board drive-chat 02 ① ⑥).
    public static let emptyHint = "Ask about your files, or say how to sort them."
    public static let emptyNote = "Every change it makes shows here, and can be undone."
    public static let placeholder = "Ask about your files, or say how to sort them"
    /// Under a new chat's empty state while its box is empty; a press fills the box and sends nothing.
    public static let examples = [
        "Sort these receipts into Receipts 2026 by month",
        "What’s taking up the most space?",
        "Find the lease and tell me when the notice period ends",
    ]
    public static let history = "Drive chats"
    public static let noHistory = "No Drive chats yet"
    public static let noWorkspace = "Add a machine or Orbit Cloud to chat about your files"
    public static let chooseWorkspace = "Choose where Drive chats run"
    /// The round button's green check (board ④).
    public static let updated = "Drive updated"
    /// The session header's origin tag.
    public static let fromDrive = "From Drive"

    /// The folder chip: `Folder · Scans`, `Folder · Drive` at the top level.
    public static func folderLabel(_ name: String) -> String { "Folder · \(name)" }

    // The cards (board ② ③ ⑦ ⑧).
    public static let changesTitle = "Drive changes"
    public static let needsYou = "Needs you"
    public static let undone = "Undone"
    public static let applying = "Applying…"
    public static let undoing = "Undoing…"
    public static let showAll = "Show all"
    public static let showLess = "Show less"
    public static let undo = "Undo"
    public static let apply = "Apply"
    public static let replaceTitle = "Replace a file?"
    public static let keepBoth = "Keep both"
    public static let replace = "Replace"
    public static let alreadyThere = "Already there"
    public static let incoming = "Incoming"
    public static let replaced = "Replaced. The old file is in its versions."
    public static let staleQuestion = "This question is no longer open."

    public static func keptBoth(_ savedAs: String?) -> String {
        "Kept both\(savedAs.map { " · saved as \($0)" } ?? "")."
    }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }

    /// `Done · 24 changes`.
    public static func done(_ n: Int) -> String { "Done · \(plural(n, "change", "changes"))" }
    /// `212 changes waiting for Apply`.
    public static func pending(_ n: Int) -> String { "\(plural(n, "change", "changes")) waiting for Apply" }
    /// `and 20 more`.
    public static func more(_ n: Int) -> String { "and \(n) more" }
    /// `2 left as they are`.
    public static func skipped(_ n: Int) -> String { "\(n) left as \(n == 1 ? "it is" : "they are")" }
    /// The chip of a selection: `12 files`; one name when there is one.
    public static func selection(_ names: [String]) -> String {
        names.count == 1 ? names[0] : plural(names.count, "file", "files")
    }

    /// The marks a chat's changes leave on the list (board ② ⑤).
    public static let markNew = "New"
    public static let markMoved = "Moved"
    public static let markRenamed = "Renamed"

    static let kindLabels: [String: String] = [
        "NEW_FOLDER": "New folder", "NEW_FILE": "New file", "MOVE": "Moved", "RENAME": "Renamed", "TRASH": "To Trash",
        "EDIT": "Edited",
    ]

    /// Every `DRIVE_*` string the web libs export, by its name.
    public static let web: [String: String] = [
        "DRIVE_CHAT_EMPTY_HINT": emptyHint,
        "DRIVE_CHAT_EMPTY_NOTE": emptyNote,
        "DRIVE_CHAT_PLACEHOLDER": placeholder,
        "DRIVE_CHAT_HISTORY": history,
        "DRIVE_CHAT_NO_HISTORY": noHistory,
        "DRIVE_CHAT_NO_WORKSPACE": noWorkspace,
        "DRIVE_CHAT_UPDATED": updated,
        "DRIVE_CHANGES_TITLE": changesTitle,
        "DRIVE_CHANGES_NEEDS_YOU": needsYou,
        "DRIVE_CHANGES_UNDONE": undone,
        "DRIVE_CHANGES_APPLYING": applying,
        "DRIVE_CHANGES_UNDOING": undoing,
        "DRIVE_CHANGES_SHOW_ALL": showAll,
        "DRIVE_CHANGES_SHOW_LESS": showLess,
        "DRIVE_CHANGES_UNDO": undo,
        "DRIVE_CHANGES_APPLY": apply,
        "DRIVE_REPLACE_TITLE": replaceTitle,
        "DRIVE_REPLACE_KEEP_BOTH": keepBoth,
        "DRIVE_REPLACE_REPLACE": replace,
    ]

    /// The shared `DRIVE_CHAT_COPY`, by its key.
    public static let shared: [String: String] = [
        "fromDrive": fromDrive,
        "runsIn": WikiChatCopy.runsIn,
        "chooseWorkspace": chooseWorkspace,
    ]
}

/// The Drive chat's rules on iOS and macOS (the web's driveChat.ts and driveChanges.ts): the chats read as the chat
/// host's list, which chat opens, what a message carries, the cards' lines and states, the round button's count and the
/// marks the list carries.
public enum DriveChatLogic {
    /// The host's scope for Drive: the chat model keeps its chats by scope, and Drive has one.
    public static let scope = "drive"
    /// How many items a card lists before "and N more".
    public static let preview = 4
    /// The window width from which file details stand beside the list even while the chat is open (board ③).
    public static let detailsBesideWidth: Double = 1760
    /// The panel's width on a Mac until it is dragged (board ③: 400, dragged 320 to half the window).
    public static let panelWidth: Double = 400
    /// The most open chats whose changes are read for marks and the round button's count.
    public static let chatsRead = 20

    // MARK: the chats read

    /// `GET /drive/chats` as the chat host reads a chats list (the web's `driveChatHostList`): the server's default
    /// workspace is the one a new chat runs in, and where else it may run is `choices` — the owner's workspaces, which the
    /// Drive host lists itself, the default among them.
    public static func hostList(_ list: DriveChatList, choices: [WikiChatWorkspace] = []) -> WikiChatList {
        let workspace = list.workspace.map {
            WikiChatWorkspace(id: $0.id, name: $0.name, runner: $0.runner, online: $0.online, eligible: true)
        }
        var all = choices
        if let workspace, !all.contains(where: { PublicID.storageKey($0.id) == PublicID.storageKey(workspace.id) }) {
            all.insert(WikiChatWorkspace(id: workspace.id, name: workspace.name, runner: workspace.runner,
                                         online: workspace.online), at: 0)
        }
        return WikiChatList(
            spaceId: scope, workspace: workspace, choices: workspace == nil && choices.isEmpty ? [] : all,
            fab: WikiChatFabCounts(needsYou: list.fab.needsYou, working: list.fab.working, updated: 0),
            chats: list.chats.map(hostRow), more: list.more)
    }

    /// A Drive chat's row as the host's history and button read it: no cards, so no drafts.
    public static func hostRow(_ row: DriveChatRow) -> WikiChatRow {
        WikiChatRow(sessionId: row.sessionId, title: row.title, status: row.status, open: row.open,
                    completed: row.completed, working: row.working, createdAt: row.createdAt, updatedAt: row.updatedAt,
                    lastActiveAt: row.lastActiveAt, drafts: 0, needsYou: row.needsYou)
    }

    /// Which chat the panel opens on (`driveChatToOpen`): the one that needs the owner, else the most recent open one,
    /// else a new chat. A completed chat is not continued.
    public static func toOpen(_ chats: [WikiChatRow]?) -> String {
        let rows = (chats ?? []).filter { $0.open && !$0.completed }
        return rows.first { $0.needsYou > 0 }?.sessionId ?? rows.first?.sessionId ?? WikiChatLogic.newChat
    }

    /// The round button (`driveChatFab`): the Wiki's four looks, its green check read as the drive's.
    public static func fab(_ counts: WikiChatFabCounts?) -> WikiChatLogic.FabLook {
        let look = WikiChatLogic.fab(counts)
        return look.state == .updated ? WikiChatLogic.FabLook(state: .updated, label: DriveChatCopy.updated, count: 0) : look
    }

    /// Whether a page wears the chat (board ① note 6): the drive's files view; Trash and Storage do not.
    public static func shown(_ place: DrivePlace) -> Bool { place == .drive }

    // MARK: sending

    /// The folder and the files a message carries (`driveChatContext`): what the composer's chips show; nil when it
    /// shows neither, which a new chat sends as `noFolder`.
    public static func context(_ attachments: WikiChatLogic.Attachments) -> DriveChatContext? {
        let (page, _) = WikiChatLogic.shown(attachments)
        let files = WikiChatLogic.shownFiles(attachments)
        var folder: String??
        if case .folder(let id, _)? = page { folder = .some(id) }
        guard folder != nil || files != nil else { return nil }
        return DriveChatContext(folderId: folder ?? nil, entryIds: files?.ids ?? [])
    }

    /// `POST /drive/chats`'s body from the composer's first message (`createDriveChat`).
    public static func createRequest(_ first: WikiChatLogic.FirstMessage, workspaceId: String?,
                                     context: DriveChatContext?, clientTurnId: String) -> DriveChatCreateRequest? {
        let words = first.words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return nil }
        return DriveChatCreateRequest(
            text: words, clientTurnId: clientTurnId, workspaceId: workspaceId, context: context,
            attachmentIds: first.attachmentIds.isEmpty ? nil : first.attachmentIds,
            model: first.model, permissionMode: first.permissionMode, effort: first.effort,
            fastMode: first.fastMode ? true : nil)
    }

    // MARK: the cards

    /// One line of a card: its kind (`New folder`, `Moved`) and what it was done to.
    public struct Line: Equatable, Sendable, Identifiable {
        public let id: String
        public let kind: String
        public let detail: String

        public init(id: String, kind: String, detail: String) {
            self.id = id
            self.kind = kind
            self.detail = detail
        }
    }

    private static func label(_ kind: String) -> String { DriveChatCopy.kindLabels[kind] ?? kind }

    static func itemLine(_ item: DriveChatChangeItem) -> Line {
        let kind = label(item.kind)
        let before = item.before.name ?? "", after = item.after.name ?? ""
        switch item.kind {
        case "RENAME": return Line(id: item.id, kind: kind, detail: "\(before) → \(after)")
        case "MOVE": return Line(id: item.id, kind: kind, detail: "\(after) → \(item.after.parentPath ?? DriveLogic.title)")
        case "TRASH": return Line(id: item.id, kind: kind, detail: before)
        default: return Line(id: item.id, kind: kind, detail: after)
        }
    }

    static func heldLine(_ item: DriveChatHeldItem) -> Line {
        let kind = label(item.kind)
        if item.kind == "MOVE" || item.kind == "RENAME" {
            return Line(id: item.id, kind: kind, detail: "\(item.fromPath ?? item.name) → \(item.toPath ?? "")")
        }
        return Line(id: item.id, kind: kind, detail: item.name)
    }

    /// What a group's card lists: what was made, or for a group held for Apply what is held (`driveGroupLines`).
    public static func lines(_ group: DriveChatChangeGroup) -> [Line] {
        group.status == .pending ? group.heldItems.map(heldLine) : group.items.map(itemLine)
    }

    public enum CardTone: Equatable, Sendable {
        /// Made: green.
        case done
        /// Waits on the owner: amber.
        case needsYou
        /// Reversed, or running: grey.
        case quiet
    }

    /// A change card as it is drawn: its state word, its tone, the lines shown, the note under them and its buttons.
    public struct ChangesLook: Equatable, Sendable {
        public let state: String
        public let tone: CardTone
        public let lines: [Line]
        /// `and N more`, while the card is not showing all.
        public let more: String?
        /// `212 changes waiting for Apply` on a held group.
        public let pending: String?
        /// `2 left as they are` once Undo left some.
        public let skipped: String?
        /// Show all / Show less, when there are more lines than the preview.
        public let toggle: String?
        public let undo: Bool
        public let apply: Bool
        /// A press is running: the buttons wait.
        public let busy: Bool
    }

    public static func changesLook(_ group: DriveChatChangeGroup, all: Bool, pressing: Bool = false) -> ChangesLook {
        let lines = lines(group)
        let shown = all ? lines : Array(lines.prefix(preview))
        let state: String
        let tone: CardTone
        switch group.status {
        case .done: state = DriveChatCopy.done(group.total); tone = .done
        case .pending: state = DriveChatCopy.needsYou; tone = .needsYou
        case .applying: state = DriveChatCopy.applying; tone = .quiet
        case .undoing: state = DriveChatCopy.undoing; tone = .quiet
        case .undone: state = DriveChatCopy.undone; tone = .quiet
        }
        return ChangesLook(
            state: state, tone: tone,
            // An undone card says what Undo left, not what it reversed (board ② beside: "2 left as they are").
            lines: group.status == .undone ? [] : shown,
            more: group.status != .undone && !all && lines.count > shown.count ? DriveChatCopy.more(lines.count - shown.count) : nil,
            pending: group.status == .pending ? DriveChatCopy.pending(group.heldItems.count) : nil,
            skipped: group.skipped > 0 ? DriveChatCopy.skipped(group.skipped) : nil,
            toggle: group.status != .undone && lines.count > preview ? (all ? DriveChatCopy.showLess : DriveChatCopy.showAll) : nil,
            undo: group.status == .done, apply: group.status == .pending,
            busy: pressing || group.status == .applying || group.status == .undoing)
    }

    /// A group that waits for the owner's Apply.
    public static func needsYou(_ group: DriveChatChangeGroup) -> Bool { group.status == .pending }

    /// A question the owner has yet to answer.
    public static func needsYou(_ question: DriveChatQuestion) -> Bool {
        question.status == .open || question.status == .answering
    }

    /// One side of an overwrite card: `/Receipts/may.pdf`, `1.2 MB · You · Jan 4` (`driveQuestionFacts`).
    public struct Facts: Equatable, Sendable {
        public let path: String
        public let size: String
        public let writer: String
        public let when: String
        public var line: String { "\(size) · \(writer) · \(when)" }
    }

    public static func facts(_ file: DriveChatQuestionFile, now: Date = Date(), calendar: Calendar = .current) -> Facts {
        let writer = file.lastWriter
        let who = writer.kind == "OWNER" ? "You"
            : writer.sessionTitle.map { "Agent in \($0)" } ?? (writer.kind == "AGENT" ? "An agent" : "Another machine")
        return Facts(path: file.path, size: DriveLogic.formatSize(file.sizeBytes), writer: who,
                     when: DriveLogic.formatWhen(file.modifiedAt, now: now, calendar: calendar))
    }

    /// The line an answered or stale question says in place of its buttons.
    public static func questionNote(_ question: DriveChatQuestion) -> String? {
        switch question.status {
        case .answered: return question.choice == .replace ? DriveChatCopy.replaced : DriveChatCopy.keptBoth(question.outcome?.name)
        case .stale: return question.reason ?? DriveChatCopy.staleQuestion
        case .open, .answering: return nil
        }
    }

    // MARK: where a chat's cards stand

    /// A card of a chat: a change group or a question, with the turn it belongs to.
    public enum Card: Equatable, Sendable, Identifiable {
        case changes(DriveChatChangeGroup)
        case question(DriveChatQuestion)

        public var id: String {
            switch self {
            case .changes(let group): return "group:\(group.id)"
            case .question(let question): return "question:\(question.id)"
            }
        }

        public var turnId: String {
            switch self {
            case .changes(let group): return group.turnId
            case .question(let question): return question.turnId
            }
        }

        public var createdAt: String {
            switch self {
            case .changes(let group): return group.createdAt
            case .question(let question): return question.createdAt
            }
        }

        public var needsYou: Bool {
            switch self {
            case .changes(let group): return DriveChatLogic.needsYou(group)
            case .question(let question): return DriveChatLogic.needsYou(question)
            }
        }
    }

    /// A chat's cards, oldest first: what the conversation draws, each after its turn.
    public static func cards(groups: [DriveChatChangeGroup], questions: [DriveChatQuestion]) -> [Card] {
        (groups.map(Card.changes) + questions.map(Card.question))
            .enumerated()
            .sorted { $0.element.createdAt != $1.element.createdAt ? $0.element.createdAt < $1.element.createdAt : $0.offset < $1.offset }
            .map(\.element)
    }

    /// What waits on the owner beyond the approvals the chats read counts: held groups and open questions.
    public static func needYou(groups: [DriveChatChangeGroup], questions: [DriveChatQuestion]) -> Int {
        groups.filter(needsYou).count + questions.filter(needsYou).count
    }

    // MARK: the marks (board ② ⑤)

    public enum Mark: String, Equatable, Sendable {
        case new = "New", moved = "Moved", renamed = "Renamed"
    }

    /// The rows a Drive chat's groups left marked, entry id (storage key) → mark and the item that made it: created,
    /// moved in or renamed by a group that is made, by an item that stood. A row a later item changed again shows the
    /// latest (`driveMarks`).
    public static func marks(_ groups: [DriveChatChangeGroup]) -> [String: (mark: Mark, key: String)] {
        let kinds: [String: Mark] = ["NEW_FOLDER": .new, "NEW_FILE": .new, "MOVE": .moved, "RENAME": .renamed]
        var marks: [String: (mark: Mark, key: String)] = [:]
        let ordered = groups.enumerated()
            .sorted { $0.element.createdAt != $1.element.createdAt ? $0.element.createdAt < $1.element.createdAt : $0.offset < $1.offset }
            .map(\.element)
        for group in ordered where group.status == .done {
            for item in group.items {
                guard let mark = kinds[item.kind], item.state == "DONE" else { continue }
                marks[PublicID.storageKey(item.entryId)] = (mark, item.id)
            }
        }
        return marks
    }

    /// The marks the owner opened, kept on the device per account: an item id each, the newest 500.
    public static func seenKey(account: String) -> String { "orbit.driveChat.seen.\(PublicID.storageKey(account))" }

    public static func remember(_ key: String, in seen: [String]) -> [String] {
        guard !seen.contains(key) else { return seen }
        return Array((seen + [key]).suffix(500))
    }

    /// Where ✕ is remembered on this device, per account (board ① note 5).
    public static func closedKey(account: String) -> String { "orbit.driveChat.closed.\(PublicID.storageKey(account))" }

    // MARK: the details (board ③)

    /// Details overlay the list while the chat column is open and the window is narrower than 1760; else they are a
    /// column (`driveDetailsOverlay`).
    public static func detailsOverlay(chatOpen: Bool, windowWidth: Double) -> Bool {
        chatOpen && windowWidth < detailsBesideWidth
    }

    // MARK: the note on the owner's bubble

    /// What the `<orbit_drive_chat>` block a message carries is named on the "Orbit attached:" line: `Folder · Scans`,
    /// `Folder · Scans · 12 files`, `12 files`. Nil when it names neither a folder nor a selection — a first message's
    /// guidance alone is the chat's own words, not something the owner attached.
    public static func noteLabel(_ block: String) -> String? {
        let text = block.drop { $0.isWhitespace }
        let open = "<\(noteTag)"
        guard text.hasPrefix(open), let close = text.firstIndex(of: ">") else { return nil }
        let head = String(text[text.index(text.startIndex, offsetBy: open.count)..<close])
        var attributes: [String: String] = [:]
        let pattern = try? NSRegularExpression(pattern: #"([a-zA-Z_]+)="([^"]*)""#)
        for match in pattern?.matches(in: head, range: NSRange(head.startIndex..., in: head)) ?? [] {
            guard let name = Range(match.range(at: 1), in: head), let value = Range(match.range(at: 2), in: head) else { continue }
            attributes[String(head[name])] = String(head[value])
                .replacingOccurrences(of: "&quot;", with: "\"").replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&amp;", with: "&")
        }
        var parts: [String] = []
        if let folder = attributes["folder"] {
            let name = folder == "/" ? DriveLogic.title : (folder.split(separator: "/").last.map(String.init) ?? folder)
            parts.append(DriveChatCopy.folderLabel(name))
        }
        if let raw = attributes["selected"], let n = Int(raw), n > 0 {
            parts.append("\(n) \(n == 1 ? "file" : "files")")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The tag of the note every delivered Drive-chat turn carries (`DRIVE_CHAT_NOTE_TAG`).
    public static let noteTag = "orbit_drive_chat"
}
