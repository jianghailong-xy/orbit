import Foundation

/// Every sentence the wiki chat draws on iOS and macOS (docs/wiki-chat-design.md §3–§9, board 42 ⑤): the contract's
/// `chat.copy` — the shared `WIKI_CHAT_COPY` the server writes with, which the web's `src/web/src/lib/wikiChat.ts`
/// takes its words from — and the panel's own names the web lib defines beside them.
///
/// `WikiChatCopyParityTests` holds both halves, each a failure when its counterpart goes missing: every key of the
/// contract's `chat.copy` has its sentence in `contract` and every key there is one of the contract's; every
/// `WIKI_*` constant the web lib exports has its sentence in `web`. A `{name}` in a template is filled by
/// `WikiChatLogic`, as the shared functions fill it.
public enum WikiChatCopy {
    // MARK: the round button (contract `chat.copy.fab`)

    public static let fabIdle = "Chat"
    public static let fabWorking = "Working…"
    public static let fabNeedsYouOne = "1 needs you"
    public static let fabNeedsYouMany = "{n} need you"
    public static let fabUpdated = "Wiki updated"

    // MARK: the panel (contract `chat.copy.panel`)

    public static let newChat = "New chat"
    public static let runsIn = "Runs in"
    public static let fromWiki = "From Wiki"
    public static let ask = "Ask"
    public static let emptyHint = "Ask about this page, or say what should change."
    public static let emptyNote = "Nothing in the wiki changes until you apply it."
    public static let placeholder = "Ask about this page, or say what should change"
    public static let placeholderDraft = "Reply, or say what to change in the draft"
    public static let noWorktree = "Turn on worktrees for a workspace in this repository to chat here"
    public static let chooseWorkspace = "Choose where this space's chats run"
    public static let offlineTemplate = "{machine} is offline. The chat waits for it to come back."
    public static let mergeNote = "Once this reaches main, Orbit rewrites what it touches."

    // MARK: the card (contract `chat.copy.card`)

    public static let cardDraft = "Draft · {label}"
    public static let cardAddKind = "Add {kind}"
    public static let cardAmend = "Amend entry"
    public static let cardSupersede = "Supersede entry"
    public static let cardRetire = "Retire entry"
    public static let cardReinforce = "Reinforce entry"
    public static let cardChallenge = "Challenge entry"
    public static let cardChanges = "{n} changes"
    public static let cardRewrite = "Rewrite from main"
    public static let cardPlan = "Plan change"
    public static let cardRewrites = "Rewrites"
    public static let cardSources = "Sources"
    public static let cardYourMessage = "Your message in this chat"
    public static let cardFootnote = "Your message · this chat"
    public static let cardWouldRewrite = "Draft would rewrite this section"
    public static let sectionUpdated = "Updated"
    public static let cardReplaced = "Replaced"
    public static let cardReplacedNote = "A newer draft took over."
    public static let cardChanged = "Changed since this draft"
    public static let cardWeb = "Based on web content"
    public static let cardWebNote = "Read before you apply."
    public static let cardApplied = "Applied · Confirmed by you"
    /// An applied card whose challenge still waits in Review (`wikiChatAppliedInReview`): not confirmed yet.
    public static let cardAppliedInReview = "Applied · In Review"
    public static let cardAppliedInReviewNote = "Keep, amend or retire the entry in Review."
    public static let cardDiscarded = "Discarded"
    public static let cardNotApplied = "Not applied"
    public static let cardUndone = "Undone"
    public static let cardRedoMessage = "This draft no longer applies: what it changes has changed since. Draft it again from what is there now."

    // MARK: a plan card's face (contract `chat.copy.card.plan*`, `chat.copy.planFields`; C12)

    public static let cardPlanDocument = "Document"
    public static let cardPlanNewDoc = "New document in {category}"
    public static let cardPlanNewCategory = "New document in a new category, {category}"
    public static let cardPlanDocFields = "Changes its {fields}"
    public static let cardPlanAdds = "Adds"
    public static let cardPlanChanges = "Changes"
    public static let cardPlanRemoves = "Removes"
    public static let cardPlanCovers = "Covers"
    public static let cardPlanSectionFields = "{section} ({fields})"
    public static let cardPlanSectionCovers = "{section}: {covers}"
    /// The words a plan card says a document's or a section's field by (`chat.copy.planFields`).
    public static let planFields: [String: String] = [
        "category": "category", "title": "title", "question": "question", "audience": "audience", "scopeIn": "scope",
        "scopeOut": "what it leaves out", "length": "length", "kind": "kind", "covers": "covers", "sources": "sources",
    ]

    // MARK: what a card offers (contract `chat.copy.actions`)

    public static let actionApply = "Apply"
    public static let actionEdit = "Edit"
    public static let actionDiscard = "Discard"
    public static let actionRewrite = "Rewrite"
    public static let actionApplyRebuild = "Apply & rebuild"
    public static let actionOpenInPlan = "Open in Plan"
    public static let actionRedo = "Redo"
    public static let actionUndo = "Undo"
    public static let actionOpenEntry = "Open entry"
    public static let actionTryAgain = "Try again"
    public static let actionSeeChanges = "See changes"
    public static let actionSettings = "Settings"

    /// A card's button, by what it does.
    public static func action(_ action: WikiChatAction) -> String {
        switch action {
        case .apply:        return actionApply
        case .edit:         return actionEdit
        case .discard:      return actionDiscard
        case .rewrite:      return actionRewrite
        case .applyRebuild: return actionApplyRebuild
        case .openInPlan:   return actionOpenInPlan
        case .redo:         return actionRedo
        case .undo:         return actionUndo
        case .openEntry:    return actionOpenEntry
        case .tryAgain:     return actionTryAgain
        case .seeChanges:   return actionSeeChanges
        case .settings:     return actionSettings
        }
    }

    // MARK: the line under an applied card (contract `chat.copy.result`)

    public static let resultRewriting = "Rewriting {where}…"
    public static let resultRewritingFrom = "Rewriting {where} from main@{sha}…"
    public static let resultWaiting = "Rewrite waiting · {reason}"
    public static let resultFailed = "Rewrite failed"
    public static let resultUpdatedLead = "Wiki updated"
    public static let resultSentenceOne = "{where} — 1 sentence"
    public static let resultSentenceMany = "{where} — {n} sentences"
    public static let resultSame = "{where} — reads the same"
    public static let resultGone = "{where} — no longer in the plan"

    // MARK: why a rewrite waits (contract `chat.copy.waiting`, `docs.follow.waiting`)

    public static func waitingReason(_ reason: WikiDocsFollowWaiting) -> String {
        switch reason {
        case .maintenanceRunning: return "Maintenance is running"
        case .buildRunning:       return "The documents are being built"
        case .planRunning:        return "The plan is being drafted"
        case .rewriteRunning:     return "Another rewrite is running"
        case .workerNotRunning:   return "wiki worker not running"
        case .modelUnconfigured:  return "System model not configured"
        case .modelAuthFailed:    return "System model refused the key"
        case .modelDown:          return "System model unreachable"
        case .noWorkspace:        return "Maintenance has no workspace"
        case .runnerMissing:      return "The maintenance workspace has no runner"
        case .runnerOffline:      return "Waiting for the runner to come online"
        case .runnerUpgrade:      return "Upgrade the runner to read the repository"
        case .unknown:            return ""
        }
    }

    // MARK: the attachment lines (contract `chat.copy.notes`)

    public static let noteChat = "Wiki chat"
    public static let notePageDoc = "Wiki page · {where}"
    public static let notePageEntry = "Wiki entry · {title}"
    public static let notePagePlan = "Wiki plan · {doc}"
    public static let noteSelection = "Wiki selection · {where} · {sentences} · {sources}"
    public static let noteSentenceOne = "1 sentence"
    public static let noteSentenceMany = "{n} sentences"
    public static let noteSourceOne = "1 source"
    public static let noteSourceMany = "{n} sources"
    public static let noteDrafts = "Wiki drafts · {counts}"
    public static let noteApplied = "{n} applied"
    public static let noteEdited = "{n} edited"
    public static let noteDiscarded = "{n} discarded"
    public static let noteUndone = "{n} undone"
    public static let noteOutdated = "Outdated"

    // MARK: Activity's banner for W's chat part (contract `chat.copy.waitingBanner`)

    public static let waitingBannerOne = "1 rewrite needs you"
    public static let waitingBannerMany = "{n} rewrites need you"

    // MARK: the Docs rows and See changes (contract `chat.copy.changes`, `chat.copy.reasons`)

    public static let changesRewritten = "{where} rewritten · {reason} · {changed}"
    public static let changesRestored = "{where} restored · {changed}"
    public static let changedOne = "1 sentence changed"
    public static let changedMany = "{n} sentences changed"
    public static let changedSame = "reads the same"
    public static let leftOne = "1 section left for the next maintenance run"
    public static let leftMany = "{n} sections left for the next maintenance run"

    public static let reasonMaintenance = "after maintenance"
    public static let reasonBuild = "after the build of plan version {version}"
    public static let reasonMerge = "after {title} merged"
    public static let reasonLanding = "after {title} landed"
    public static let reasonChat = "after chat {title}"
    public static let reasonRestore = "restored by you"

    // MARK: the panel's own names (src/web/src/lib/wikiChat.ts, which neither the design nor the contract words)

    public static let history = "Chats in this space"
    public static let noHistory = "No chats in this space yet"
    public static let openSession = "Open as a full session"
    public static let close = "Hide chat"
    /// The native sheet's own composer's buttons (C11); the web panel draws the session page's composer (board 43).
    public static let send = "Send"
    public static let stop = "Stop"
    public static let resize = "Resize chat"
    public static let workspace = "Workspace"
    public static let sendFailed = "The message couldn’t be sent. Check the connection, then try again."
    /// The phone's Ask sheet, over the paragraph's sentences (docs/wiki-comment-to-session-design.md §5).
    public static let pickSentences = "Tap the sentences you mean"
    /// The composer's line once its chat takes no more messages (C8 review): why, and the way on.
    public static let ended = "This chat has ended, so it takes no more messages. Start a new chat to keep going."
    public static let trashed = "This chat is in Trash, so it takes no more messages. Start a new chat to keep going."

    // MARK: the card's own words (src/web/src/lib/wikiChat.ts, C9)

    /// The label of the entries a draft may duplicate (board 42 ②).
    public static let similar = "Similar"
    /// The rows of a card's face beside its kind's first field (`wikiChatCardFace`).
    public static let faceSummary = "Summary"
    public static let faceWhy = "Why"
    /// Said when a press is refused, with the server's reason after it.
    public static let pressFailed = "The card couldn’t be pressed"
    /// The card's read failing: the call stands, its card cannot be read now.
    public static let cardUnread = "This card couldn’t be read. It is still there: open the chat again to retry."
    /// The note on an undone Rewrite from main card (design §8.4, owner 11-07, C15): the Undo holds until main moves
    /// what the section draws on.
    public static let cardUndoneRewriteNote = "If main has changed the files this section draws on, the next maintenance run writes it from main again."
    /// Edit's sheet (design §7.2: as Review's Edit, the owner's own version of the ops).
    public static let editTitle = "Edit, then apply"
    public static let editNote = "What you change here is applied as your own version of the draft."
    public static let editTitleField = "Title"
    public static let editLine = "One line"
    public static let cancel = "Cancel"

    /// A press refused, lost, or failed at the server (`wikiChatPressError`).
    public static func pressRefused(_ reason: String) -> String { "\(pressFailed): \(reason)" }
    public static func pressServerFailed(_ status: Int) -> String {
        "The server couldn’t take the press (\(status)). Try again in a moment."
    }
    public static let pressUnsent = "The press didn’t reach the server. Check the connection, then try again."

    // MARK: See changes and Activity's Docs rows (src/web/src/lib/wikiChat.ts, C9)

    public static let seeChangesSame = "Every sentence reads as it did."
    public static let seeChangesNone = "No earlier version of this section is kept."
    public static let seeChangesFailed = "The versions couldn’t be loaded. Check the connection, then try again."
    public static let activityDocs = "Docs"

    /// See changes' title for one section: `See changes · 3.1 §3` (`wikiSeeChangesTitle`).
    public static func seeChangesTitle(_ place: String) -> String { "\(actionSeeChanges) · \(place)" }
    /// The fold for the versions before the one it opens on (`wikiEarlierChanges`).
    public static func earlierChanges(_ n: Int) -> String { "Earlier changes (\(n))" }

    /// The cross on an attachment chip: `Remove 3.1 §3`.
    public static func remove(_ what: String) -> String { "Remove \(what)" }

    /// Said on the quote chip when a selection ran past the cap (design §4.2: at most 20).
    public static func capped(_ selected: Int) -> String {
        "The first \(WikiChatLogic.selectionSentencesMax) of \(selected) sentences"
    }

    /// `HPC is offline. The chat waits for it to come back.`
    public static func offline(_ machine: String) -> String {
        WikiChatLogic.fill(offlineTemplate, ["machine": machine])
    }

    // MARK: the tables the parity test reads

    /// Every sentence of the contract's `chat.copy`, keyed `<group>.<key>` as the contract nests them.
    public static let contract: [String: String] = {
        var table: [String: String] = [
            "fab.idle": fabIdle, "fab.working": fabWorking, "fab.needsYouOne": fabNeedsYouOne,
            "fab.needsYouMany": fabNeedsYouMany, "fab.updated": fabUpdated,
            "panel.newChat": newChat, "panel.runsIn": runsIn, "panel.fromWiki": fromWiki, "panel.ask": ask,
            "panel.emptyHint": emptyHint, "panel.emptyNote": emptyNote, "panel.placeholder": placeholder,
            "panel.placeholderDraft": placeholderDraft, "panel.noWorktree": noWorktree,
            "panel.chooseWorkspace": chooseWorkspace, "panel.offline": offlineTemplate, "panel.mergeNote": mergeNote,
            "card.draft": cardDraft, "card.addKind": cardAddKind, "card.amend": cardAmend, "card.supersede": cardSupersede,
            "card.retire": cardRetire, "card.reinforce": cardReinforce, "card.challenge": cardChallenge,
            "card.changes": cardChanges, "card.rewrite": cardRewrite, "card.plan": cardPlan, "card.rewrites": cardRewrites,
            "card.sources": cardSources, "card.yourMessage": cardYourMessage, "card.footnote": cardFootnote,
            "card.wouldRewrite": cardWouldRewrite, "card.sectionUpdated": sectionUpdated, "card.replaced": cardReplaced,
            "card.replacedNote": cardReplacedNote, "card.changed": cardChanged, "card.web": cardWeb,
            "card.webNote": cardWebNote, "card.applied": cardApplied, "card.appliedInReview": cardAppliedInReview,
            "card.appliedInReviewNote": cardAppliedInReviewNote, "card.discarded": cardDiscarded,
            "card.notApplied": cardNotApplied, "card.undone": cardUndone, "card.redoMessage": cardRedoMessage,
            "card.planDocument": cardPlanDocument, "card.planNewDoc": cardPlanNewDoc, "card.planNewCategory": cardPlanNewCategory,
            "card.planDocFields": cardPlanDocFields, "card.planAdds": cardPlanAdds, "card.planChanges": cardPlanChanges,
            "card.planRemoves": cardPlanRemoves, "card.planCovers": cardPlanCovers, "card.planSectionFields": cardPlanSectionFields,
            "card.planSectionCovers": cardPlanSectionCovers,
            "result.rewriting": resultRewriting, "result.rewritingFrom": resultRewritingFrom,
            "result.waiting": resultWaiting, "result.failed": resultFailed, "result.updatedLead": resultUpdatedLead,
            "result.sentenceOne": resultSentenceOne, "result.sentenceMany": resultSentenceMany,
            "result.same": resultSame, "result.gone": resultGone,
            "notes.chat": noteChat, "notes.pageDoc": notePageDoc, "notes.pageEntry": notePageEntry,
            "notes.pagePlan": notePagePlan, "notes.selection": noteSelection, "notes.sentenceOne": noteSentenceOne,
            "notes.sentenceMany": noteSentenceMany, "notes.sourceOne": noteSourceOne, "notes.sourceMany": noteSourceMany,
            "notes.drafts": noteDrafts, "notes.applied": noteApplied, "notes.edited": noteEdited,
            "notes.discarded": noteDiscarded, "notes.undone": noteUndone, "notes.outdated": noteOutdated,
            "waitingBanner.one": waitingBannerOne, "waitingBanner.many": waitingBannerMany,
            "changes.rewritten": changesRewritten, "changes.restored": changesRestored, "changes.changedOne": changedOne,
            "changes.changedMany": changedMany, "changes.same": changedSame, "changes.leftOne": leftOne,
            "changes.leftMany": leftMany,
            "reasons.maintenance": reasonMaintenance, "reasons.build": reasonBuild, "reasons.merge": reasonMerge,
            "reasons.landing": reasonLanding, "reasons.chat": reasonChat, "reasons.restore": reasonRestore,
        ]
        for (field, word) in planFields { table["planFields.\(field)"] = word }
        for action in WikiChatAction.allCases { table["actions.\(action.rawValue)"] = Self.action(action) }
        for reason in WikiDocsFollowWaiting.allCases where reason != .unknown {
            table["waiting.\(reason.rawValue)"] = waitingReason(reason)
        }
        return table
    }()

    /// Every `WIKI_*` string the web lib exports, by its name: the contract's it takes and its own.
    public static let web: [String: String] = [
        "WIKI_CHAT_LABEL": fabIdle,
        "WIKI_CHAT_NEW": newChat,
        "WIKI_CHAT_RUNS_IN": runsIn,
        "WIKI_CHAT_ASK": ask,
        "WIKI_CHAT_EMPTY_HINT": emptyHint,
        "WIKI_CHAT_EMPTY_NOTE": emptyNote,
        "WIKI_CHAT_PLACEHOLDER": placeholder,
        "WIKI_CHAT_PLACEHOLDER_DRAFT": placeholderDraft,
        "WIKI_CHAT_NO_WORKTREE": noWorktree,
        "WIKI_CHAT_CHOOSE_WORKSPACE": chooseWorkspace,
        "WIKI_CHAT_HISTORY": history,
        "WIKI_CHAT_NO_HISTORY": noHistory,
        "WIKI_CHAT_OPEN_SESSION": openSession,
        "WIKI_CHAT_CLOSE": close,
        "WIKI_CHAT_RESIZE": resize,
        "WIKI_CHAT_WORKSPACE": workspace,
        "WIKI_CHAT_SEND_FAILED": sendFailed,
        "WIKI_CHAT_PICK_SENTENCES": pickSentences,
        "WIKI_CHAT_ENDED": ended,
        "WIKI_CHAT_TRASHED": trashed,
        "WIKI_CHAT_SOURCES": cardSources,
        "WIKI_CHAT_REWRITES": cardRewrites,
        "WIKI_CHAT_SIMILAR": similar,
        "WIKI_CHAT_WEB": cardWeb,
        "WIKI_CHAT_WEB_NOTE": cardWebNote,
        "WIKI_CHAT_WOULD_REWRITE": cardWouldRewrite,
        "WIKI_CHAT_SECTION_UPDATED": sectionUpdated,
        "WIKI_CHAT_REDO_MESSAGE": cardRedoMessage,
        "WIKI_CHAT_PRESS_FAILED": pressFailed,
        "WIKI_CHAT_CARD_UNREAD": cardUnread,
        "WIKI_CHAT_UNDONE_REWRITE_NOTE": cardUndoneRewriteNote,
        "WIKI_CHAT_EDIT_TITLE": editTitle,
        "WIKI_CHAT_EDIT_NOTE": editNote,
        "WIKI_CHAT_EDIT_TITLE_FIELD": editTitleField,
        "WIKI_CHAT_EDIT_LINE": editLine,
        "WIKI_CHAT_CANCEL": cancel,
        "WIKI_SEE_CHANGES_SAME": seeChangesSame,
        "WIKI_SEE_CHANGES_NONE": seeChangesNone,
        "WIKI_SEE_CHANGES_FAILED": seeChangesFailed,
        "WIKI_ACTIVITY_DOCS": activityDocs,
    ]
}
