import Foundation

/// The Scheduled page chat's words on iOS and macOS: the web's (src/web/src/lib/scheduledChat.ts,
/// src/web/src/components/ScheduleChatExtras.tsx; the shared `SCHEDULE_PAGE_CHAT_COPY`), word for word —
/// `ScheduledChatCopyParityTests` holds them to it. "‹ Chat" is board scheduled-chat 01 part 4 ③'s.
public enum ScheduledChatCopy {
    /// The page's toolbar button (board 1 ①, 4 ①).
    public static let button = "Chat"
    /// A chat's title until the session has one of its own.
    public static let title = "Scheduled chat"
    public static let history = "Scheduled chats"
    public static let noHistory = "No Scheduled chats yet"
    public static let placeholder = "Ask about your schedules, or say what to change…"
    public static let noWorkspace = "Add a machine or Orbit Cloud to manage your schedules by chat"
    public static let chooseWorkspace = "Choose where this chat runs"
    /// The session row's tag (`SCHEDULE_PAGE_CHAT_COPY.fromScheduled`, design §4.3 D4 A).
    public static let fromScheduled = "From Scheduled"
    /// The Run now button the agent offers (design §4.6, board 3 ③): the person's press.
    public static let runNow = "Run now"
    public static let started = "Started"
    public static let openRun = "open run"
    /// The schedule's sheet opened from the chat sheet goes back to the conversation (board 4 ③).
    public static let back = "Chat"

    /// The amber count's spoken words.
    public static func waiting(_ n: Int) -> String { "\(n) waiting" }

    /// The web's exported strings, by name (`ScheduledChatCopyParityTests`).
    public static let web: [String: String] = [
        "SCHEDULED_CHAT_BUTTON": button,
        "SCHEDULED_CHAT_TITLE": title,
        "SCHEDULED_CHAT_HISTORY": history,
        "SCHEDULED_CHAT_NO_HISTORY": noHistory,
        "SCHEDULED_CHAT_PLACEHOLDER": placeholder,
        "SCHEDULED_CHAT_NO_WORKSPACE": noWorkspace,
        "SCHEDULED_CHAT_CHOOSE_WORKSPACE": chooseWorkspace,
    ]

    /// `RUN_NOW_COPY`, by key.
    public static let runNowWeb: [String: String] = ["button": runNow, "started": started, "openRun": openRun]
}

/// The Scheduled page chat's rules on iOS and macOS (docs/scheduled-chat-design.md §3, §4, §6; the web's
/// scheduledChat.ts and scheduledChatOffers.ts): the Wiki chat's panel, model and history, read from the account's
/// sessions tagged `SCHEDULE_CHAT`, opened only by the toolbar's Chat button and remembered per device.
public enum ScheduledChatLogic {
    /// The host's one scope, as Drive has one: the chats are the account's, not a space's.
    public static let scope = "scheduled"
    /// A session opened by the page chat's door (`chatOrigin`).
    public static let origin = "SCHEDULE_CHAT"

    // MARK: the chats

    public static func isScheduledChat(_ session: Session) -> Bool { session.chatOrigin == origin }

    /// The tag a session's row carries (the web's `SessionTitleRow`): From Scheduled for a page chat, none otherwise.
    public static func originTag(_ chatOrigin: String?) -> String? {
        chatOrigin == origin ? ScheduledChatCopy.fromScheduled : nil
    }

    /// A page chat's session row as the panel's history and button read it (`scheduledChatRow`).
    public static func row(_ session: Session) -> WikiChatRow {
        let completed = session.effectiveLifecycleState == .completed || session.completedAt != nil
        let approvals = max(0, session.pendingApprovals ?? 0)
        let at = session.lastTurnAt ?? session.createdAt
        let status = session.effectiveRunStatus
        let title = (session.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return WikiChatRow(sessionId: session.id, title: title.isEmpty ? ScheduledChatCopy.title : title,
                           status: status.rawValue, open: !completed, completed: completed,
                           working: session.phase == .running || status == .running || status == .pending,
                           createdAt: session.createdAt, updatedAt: at, lastActiveAt: at, drafts: 0,
                           needsYou: max(approvals, session.waitingOn == .person ? 1 : 0))
    }

    /// Newest spoken in first.
    static func byLastActive(_ a: WikiChatRow, _ b: WikiChatRow) -> Bool {
        let date: (WikiChatRow) -> Date = { RelativeTime.parse($0.lastActiveAt ?? $0.updatedAt ?? "") ?? .distantPast }
        return date(a) > date(b)
    }

    /// The chats as the host reads them (`scheduledChatHostList`): where a new chat runs, the owner's workspaces to
    /// pick from, the open page chats from the Open list, and the button's counts — the chats' approvals and the
    /// schedule cards waiting in them (`waitingCards`).
    public static func hostList(sessions: [Session], workspace: WikiChatWorkspace?, choices: [WikiChatWorkspace],
                                waitingCards: Int = 0) -> WikiChatList {
        let chats = sessions.filter(isScheduledChat).map(row).filter(\.open).sorted(by: byLastActive)
        let remembered = workspace.map {
            WikiChatWorkspace(id: $0.id, name: $0.name, runner: $0.runner, online: $0.online, eligible: true)
        }
        return WikiChatList(
            spaceId: scope, workspace: remembered, choices: choices,
            fab: WikiChatFabCounts(needsYou: chats.reduce(0) { $0 + $1.needsYou } + max(0, waitingCards),
                                   working: chats.contains { $0.working }, updated: 0),
            chats: chats, more: false)
    }

    /// The history (design §3): Open and Completed page chats, searched by title, newest first.
    public static func history(open: [Session], completed: [Session], query: String) -> [WikiChatRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var seen = Set<String>()
        return (open + completed)
            .filter(isScheduledChat)
            .filter { seen.insert(PublicID.storageKey($0.id)).inserted }
            .map(row)
            .filter { needle.isEmpty || $0.title.lowercased().contains(needle) }
            .sorted(by: byLastActive)
    }

    /// Which chat the button opens (`scheduledChatToOpen`): the one with a card waiting, else the account's open one
    /// (`GET`'s), else the newest open one listed, else a new chat. A completed chat is not continued.
    public static func toOpen(_ chats: [WikiChatRow]?, openID: String?) -> String {
        let rows = (chats ?? []).filter { $0.open && !$0.completed }
        return rows.first { $0.needsYou > 0 }?.sessionId ?? openID ?? rows.first?.sessionId ?? WikiChatLogic.newChat
    }

    /// Where Runs in starts (design §5, `scheduledChatDefaultWorkspace`): the page's workspace filter when one is set,
    /// else the first of the owner's workspaces with a machine, in their own order — never the last one used.
    public static func defaultWorkspace(filter: String?, choices: [WikiChatWorkspace]) -> WikiChatWorkspace? {
        if let filter, let match = choices.first(where: { PublicID.storageKey($0.id) == PublicID.storageKey(filter) }) {
            return match
        }
        return choices.first
    }

    // MARK: what a message carries (design §2.4, §4.2)

    /// The selected row, as the composer's chip: one id and its title, crossed out until another row is selected.
    public static func chip(scheduleID: String, title: String) -> WikiChatLogic.Files {
        WikiChatLogic.Files(ids: [scheduleID], names: [title])
    }

    /// The page's view a message carries (`scheduledChatContext`): the workspace filter and the schedule whose chip is
    /// shown. Nil when it carries neither.
    public static func context(filter: String?, attachments: WikiChatLogic.Attachments) -> SchedulePageChatContext? {
        let selected = WikiChatLogic.shownFiles(attachments)?.ids.first
        guard filter != nil || selected != nil else { return nil }
        return SchedulePageChatContext(scheduleFilter: filter, scheduleId: selected)
    }

    // MARK: the panel (design §3 D3 A, board 4)

    /// Open or closed, kept on this device for the signed-in account.
    public static func shownKey(account: String) -> String { "orbit.scheduledChat.shown.\(PublicID.storageKey(account))" }

    /// Whether the page shows the chat as it opens: only where the chat is a column (a Mac, an iPad at a regular
    /// width), and only when it was left open there. Never on a phone's sheet, and never the first time.
    public static func opensOnPage(sheet: Bool, remembered: Bool) -> Bool { !sheet && remembered }

    /// One step of what a press does to the page.
    public enum Step: Equatable, Sendable {
        /// Fold the chat's sheet away (a phone shows one sheet at a time).
        case closeChat
        /// Show the chat again, on the chat it showed.
        case openChat
        /// Show the schedule: the Mac's inspector, an iPad's or a phone's sheet. `backToChat` puts ‹ Chat at its head.
        case openSchedule(id: String, backToChat: Bool)
        /// The schedule's sheet goes.
        case closeSchedule
    }

    /// How the chat is shown: a column beside the page, sliding over the inspector (a Mac under 1200 points), or a
    /// sheet (an iPhone, a compact iPad).
    public enum Presentation: Equatable, Sendable { case column, overlay, sheet }

    /// A schedule's name in a change line (board 4 ③, design §0.5, §6): in a column the chat stays and the schedule
    /// opens beside it; sliding over the inspector, the chat closes and the inspector shows the schedule; in a sheet the
    /// chat folds away and the schedule's own sheet opens with ‹ Chat at its head.
    public static func nameTapped(_ scheduleID: String, presentation: Presentation) -> [Step] {
        switch presentation {
        case .column: return [.openSchedule(id: scheduleID, backToChat: false)]
        case .overlay: return [.closeChat, .openSchedule(id: scheduleID, backToChat: false)]
        case .sheet: return [.closeChat, .openSchedule(id: scheduleID, backToChat: true)]
        }
    }

    /// ‹ Chat on a schedule's sheet: back to the conversation it came from.
    public static func backToChat() -> [Step] { [.closeSchedule, .openChat] }

    // MARK: Run now (design §4.6, D6 A)

    /// A Run now button the agent offered: after its turn, once per schedule per message.
    public struct RunNowOffer: Equatable, Sendable, Identifiable {
        public let scheduleID: String
        public let turnID: String
        /// The assistant message that offered it.
        public let messageID: String
        /// Stable across reads: the message and the schedule.
        public let id: String
    }

    /// Each schedule an assistant message offered to run (`[Run now](orbit-run-now:<id>)`), in the order said.
    public static func runNowOffers(_ items: [TranscriptItem]) -> [RunNowOffer] {
        var offers: [RunNowOffer] = []
        var turn: String?
        for item in items {
            if case .user(let bubble) = item, let id = bubble.turnId { turn = id }
            guard case .assistant(let bubble) = item else { continue }
            let text = bubble.text.isEmpty ? bubble.streamingText : bubble.text
            var seen = Set<String>()
            for id in offeredIDs(text) where seen.insert(id).inserted {
                offers.append(RunNowOffer(scheduleID: id, turnID: bubble.turnId ?? turn ?? "", messageID: bubble.id,
                                          id: "run-now:\(bubble.id):\(id)"))
            }
        }
        return offers
    }

    /// The link's scheme, which the transcript leaves inert: the button below the message is the press.
    public static let runNowScheme = "orbit-run-now"

    static func offeredIDs(_ text: String) -> [String] {
        let marker = "\(runNowScheme):"
        var ids: [String] = []
        var rest = Substring(text)
        while let found = rest.range(of: marker) {
            let after = rest[found.upperBound...]
            let id = after.prefix { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" || $0 == "-" }
            if !id.isEmpty { ids.append(String(id)) }
            rest = after
        }
        return ids
    }

    /// The button is drawn for one of this account's listed schedules that has not ended, titled from the list: the
    /// agent's text can echo anything, so the link only names a schedule.
    public static func runNowShown(_ schedule: ScheduleView?) -> Bool {
        guard let schedule else { return false }
        return schedule.state != "ENDED"
    }

    /// A Run now card the transcript draws: the offer, and the schedule's title as the server's list has it.
    public struct RunNowCard: Equatable, Sendable, Identifiable {
        public let id: String
        public let scheduleID: String
        public let title: String
        public let turnID: String
        /// The assistant message whose link the card stands for.
        public let messageID: String
    }

    /// The cards a conversation draws (the web's `useRunNowInserts` + `RunNowOffer`): in a Scheduled page chat alone
    /// (`chatOrigin`), one per offer whose id names one of the listed schedules that has not ended, titled by the list.
    /// An id the list does not hold, or a schedule that ended, draws nothing.
    public static func runNowCards(_ items: [TranscriptItem], chatOrigin: String?, schedules: [ScheduleView]) -> [RunNowCard] {
        guard chatOrigin == origin else { return [] }
        var listed: [String: ScheduleView] = [:]
        for schedule in schedules { listed[PublicID.storageKey(schedule.id)] = schedule }
        return runNowOffers(items).compactMap { offer in
            guard let schedule = listed[PublicID.storageKey(offer.scheduleID)], runNowShown(schedule) else { return nil }
            return RunNowCard(id: offer.id, scheduleID: offer.scheduleID, title: schedule.title, turnID: offer.turnID,
                              messageID: offer.messageID)
        }
    }

    /// The answer's words with each `[label](orbit-run-now:<id>)` link taken out whose card is drawn (`drawn`, schedule
    /// ids), so the offer reads once: the card stands in the link's place. A link no card is drawn for stays, inert.
    public static func withoutDrawnOffers(_ text: String, drawn: Set<String>) -> String {
        guard !drawn.isEmpty, text.contains("\(runNowScheme):") else { return text }
        let keys = Set(drawn.map(PublicID.storageKey))
        let pattern = try! NSRegularExpression(pattern: #"\[[^\]\n]*\]\(\#(runNowScheme):([A-Za-z0-9_-]+)\)"#)
        var out = text
        for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let idRange = Range(match.range(at: 1), in: text), keys.contains(PublicID.storageKey(String(text[idRange]))),
                  let whole = Range(match.range, in: out) else { continue }
            out.removeSubrange(whole)
        }
        // A line the link stood on alone goes with it.
        let lines = out.components(separatedBy: "\n")
        var kept: [String] = []
        for line in lines {
            let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
            if blank, let last = kept.last, last.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            kept.append(blank ? "" : line)
        }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: the Mac's layout (design §6)

    /// Where the Mac shows the chat: a third column beside the inspector when list, inspector and chat fit — from 1200
    /// points, the source list folding as on the web's 1200–1439 band — else sliding over the inspector, so no column
    /// is squeezed under its minimum.
    public enum MacLayout: Equatable, Sendable { case column, overlay }

    /// The window width from which the Mac shows three columns (list 400 + inspector 320 + chat 400, with room).
    public static let columnWindowMin: Double = 1200
    /// The inspector's narrowest (design §6).
    public static let inspectorMin: Double = 320

    public static func macLayout(windowWidth: Double) -> MacLayout {
        windowWidth >= columnWindowMin ? .column : .overlay
    }
}
