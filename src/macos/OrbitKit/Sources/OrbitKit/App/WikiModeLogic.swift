import Foundation

// The review mode's words and readings for the native pages (criterion 8) — the Swift half of the
// web's `src/web/src/lib/wikiReviewMode.ts`: the Wiki settings page, the Auto / Unreviewed /
// Web-derived marks an entry wears, the owner's Confirm and Reject, one run's page with its Revert,
// and the answers a challenge card offers.
//
// ONE SET OF SENTENCES FOR BOTH CLIENTS. `WikiReviewModeCopyParityTests` looks every constant below
// up in the web source it mirrors, and proves the readings against the cases in
// `src/shared/src/wiki-review-mode.fixture.json`, which the web's own test reads too — the two ends
// share no compiler, so this is what keeps a sentence reworded at one end from simply never
// appearing at the other. The words are the owner-confirmed mocks' (docs/mocks/wiki 17–20).
//
// Pure, with no SwiftUI, so it is tested on Linux like the rest of this directory.

/// Every sentence the review mode's pages say. The web constant each one mirrors is named beside it.
public enum WikiModeCopy {
    // MARK: Wiki settings (mocks 19–20)

    public static let settings = "Settings"                                       // WIKI_SETTINGS
    public static let settingsTitle = "Wiki settings"                             // WIKI_SETTINGS_TITLE
    public static let reviewMode = "Review mode"                                  // WIKI_REVIEW_MODE
    public static let reviewModeHint = "Only you can switch it"                   // WIKI_REVIEW_MODE_HINT
    public static let reviewModeLead = "Who has to look at a change before agents get it."   // WIKI_REVIEW_MODE_LEAD
    public static let modeDefault = "default"                                     // WIKI_MODE_DEFAULT

    /// A mode's name (`WIKI_MODE_LABELS`). Empty for one this build does not know.
    public static func modeLabel(_ mode: WikiReviewMode) -> String {
        switch mode {
        case .manual:    return "Manual"
        case .tiered:    return "Tiered"
        case .automatic: return "Automatic"
        case .unknown:   return ""
        }
    }

    /// A mode's one sentence (`WIKI_MODE_NOTES`).
    public static func modeNote(_ mode: WikiReviewMode) -> String {
        switch mode {
        case .manual:
            return "Every change from sessions, maintenance and imports waits for you in Review."
        case .tiered:
            return "Your own words and machine-checked entries apply at once; the rest show as Unreviewed and are not sent to agents."
        case .automatic:
            return "local-vllm checks each change against its sources first: supported ones apply, partly supported ones show as Unreviewed, the rest are rejected with a reason."
        case .unknown:
            return ""
        }
    }

    public static let spotCheck = "Spot-check Automatic"                          // WIKI_SPOT_CHECK
    public static let spotCheckNote = "Send 1 in 200 of the changes it applies to Review, to see what it lets through. Off by default; spot checks do not count toward the 30 waiting in Review."
    public static let floorsLead = "Always asks you, in any mode:"                // WIKI_FLOORS_LEAD
    public static let floorsNote = "principles, anything a session proposed after reading the web, and changes to entries you wrote or confirmed. A run that would change more than 10% of the wiki stops."

    public static let maintenance = "Maintenance"                                 // WIKI_MAINTENANCE
    public static let maintenanceName = WikiCopy.historyMaintenance               // WIKI_MAINTENANCE_NAME
    public static let maintenanceNote = "Keeps the wiki up to date from sessions, tasks and receipts as they settle. Runs on the workspace you pick, with the provider pinned."
    public static let off = "Off"                                                 // WIKI_OFF
    public static let on = "On"                                                   // WIKI_ON
    public static let setUp = "Set up…"                                           // WIKI_SET_UP
    public static let setUpTitle = "Set up maintenance"                           // WIKI_SET_UP_TITLE
    public static let status = "Status"                                           // WIKI_STATUS
    public static let workspace = "Workspace"                                     // WIKI_WORKSPACE
    public static let workspaceNote = "The runner that checks out this codebase; maintenance runs there."
    public static let provider = "Provider"                                       // WIKI_PROVIDER
    public static let providerNote = "Pinned: a run never falls back to another provider."
    public static let pinnedNoFallback = "pinned, no fallback"                    // WIKI_PINNED_NO_FALLBACK
    public static let dailyLimit = "Daily limit"                                  // WIKI_DAILY_LIMIT
    public static let runsADayUnit = "runs a day"                                 // WIKI_RUNS_A_DAY
    public static let dailyLimitNote = "A run starts when 20 sessions have settled, or when the oldest waits a day. Each run writes at most 30 changes."
    public static let lookback = "Look back"                                      // WIKI_LOOKBACK
    public static let lookbackNote = "How far back maintenance starts reading when you turn it on. Changing it later never moves maintenance back."
    public static let lookbackNow = "From now on"                                 // WIKI_LOOKBACK_NOW
    public static let lookbackAll = "All history"                                 // WIKI_LOOKBACK_ALL
    public static let lookbackUnit = "days"                                       // WIKI_LOOKBACK_UNIT
    public static let cancel = "Cancel"                                           // WIKI_CANCEL
    public static let turnOn = "Turn on"                                          // WIKI_TURN_ON
    public static let turnOff = "Turn off"                                        // WIKI_TURN_OFF
    /// Edit on the maintenance card. iOS opens a sheet from it, so its row says `Edit…` (mock 20 ③).
    public static let maintenanceEdit = "Edit"                                    // WIKI_MAINTENANCE_EDIT
    public static let save = "Save"                                               // WIKI_SAVE
    public static let noWorkspace = "Pick a workspace"                            // WIKI_NO_WORKSPACE

    /// `8 runs a day` (`wikiRunsADay`).
    public static func runsADay(_ runs: Int) -> String { runs == 1 ? "1 run a day" : "\(runs) \(runsADayUnit)" }

    /// `Last 14 days`, `From now on`, `All history`: a look-back as its row and its picker say it (`wikiLookbackLabel`).
    public static func lookbackLabel(_ days: Int?) -> String {
        guard let days else { return lookbackAll }
        if days == 0 { return lookbackNow }
        return days == 1 ? "Last 1 day" : "Last \(days) \(lookbackUnit)"
    }

    // MARK: an entry's marks and the owner's answers (mocks 17–18)

    public static let confirm = "Confirm"                                         // WIKI_CONFIRM
    public static let confirmed = "Confirmed"                                     // WIKI_CONFIRMED
    public static let rejected = "Rejected"                                       // WIKI_REJECTED
    public static let rejectOnRecord = "The reason goes on the record."           // WIKI_REJECT_ON_RECORD
    public static let notSentUnreviewed = "Not sent to agents while it is Unreviewed."   // WIKI_NOT_SENT_UNREVIEWED
    public static let bannerAuto = "applied without asking you, and sent to agents. Reject takes it back."
    public static let bannerUnreviewed = "applied without review, and not sent to agents until you confirm it."
    public static let bannerWebDerived = "this session read web pages before proposing. Confirming shows it to agents."
    public static let cappedAtUnreviewed = "capped at Unreviewed"                 // WIKI_CAPPED_AT_UNREVIEWED

    /// A verdict as the bar's second line says it (`WIKI_VERDICT_WORDS`).
    public static func verdictWord(_ verdict: WikiVerificationVerdict) -> String {
        switch verdict {
        case .supported:   return "supported"
        case .partial:     return "partly supported"
        case .unsupported: return "not supported"
        case .duplicate:   return "a duplicate"
        case .unknown:     return ""
        }
    }

    // MARK: one run (mocks 17 ⑧, 18 ④⑤)

    public static let run = "run"                                                 // WIKI_RUN
    public static let viewRun = "View run"                                        // WIKI_VIEW_RUN
    public static let revertRun = "Revert run…"                                   // WIKI_REVERT_RUN
    public static let revertRunConfirm = "Revert run"                             // WIKI_REVERT_RUN_CONFIRM
    public static let revertTitle = "Revert this run?"                            // WIKI_REVERT_TITLE
    public static let revertKeeps = "Changes you have confirmed, edited or rejected since are left as they are."
    public static let reverted = "Reverted"                                       // WIKI_REVERTED
    public static let openSession = "Open session"                                // WIKI_OPEN_SESSION
    public static let runAdded = "Added"                                          // WIKI_RUN_ADDED
    public static let runAmended = "Amended"                                      // WIKI_RUN_AMENDED
    public static let runReinforced = "Reinforced"                                // WIKI_RUN_REINFORCED
    /// A group's rows past the first few (`wikiShowMore`, `WIKI_SHOW_LESS`).
    public static func showMore(_ count: Int) -> String { "Show \(count) more" }
    public static let showLess = "Show less"

    /// Who a run was (`WIKI_ORIGIN_WORDS`).
    public static func originWord(_ origin: WikiChangesetOrigin?) -> String {
        switch origin {
        case .maintenance?: return WikiCopy.historyMaintenance
        case .`import`?:    return "Import"
        case .agent?:       return "A session"
        case .watch?:       return "A watch"
        case .owner?:       return "You"
        default:            return ""
        }
    }

    /// `Wiki maintenance · run` (`wikiRunKicker`).
    public static func runKicker(_ origin: WikiChangesetOrigin?) -> String { "\(originWord(origin)) · \(run)" }
    /// `Applied 24 changes` (`wikiAppliedChanges`).
    public static func appliedChanges(_ count: Int) -> String { "Applied \(count) change\(count == 1 ? "" : "s")" }
    public static func rejectedByCheck(_ count: Int) -> String { "\(count) rejected by the check" }
    public static func toReview(_ count: Int) -> String { "\(count) to review" }

    // MARK: a challenge's answers

    public static let reconfirm = "Re-confirm"                                    // WIKI_RECONFIRM
    public static let amend = "Amend"                                             // WIKI_AMEND
    public static let retire = "Retire"                                           // WIKI_RETIRE
    public static let challengeWaits = "Agents stop getting this entry until you answer."   // WIKI_CHALLENGE_WAITS
    public static let challenged = "Challenged"                                   // WIKI_CHALLENGED
    public static let amendNote = "Your version replaces the entry, and its anchors are checked again."
    /// `checked on main at 1588c3b` (`wikiCheckedOnMain`).
    public static func checkedOnMain(_ ref: String) -> String { "checked on main at \(WikiLogic.shortSha(ref))" }
}

public enum WikiModeLogic {
    // MARK: the settings page

    /// The settings page's sections, top to bottom — the web's order (`WIKI_SETTINGS_SECTIONS`).
    public enum SettingsSection: String, CaseIterable, Sendable {
        case reviewMode, maintenance

        public var title: String {
            switch self {
            case .reviewMode:  return WikiModeCopy.reviewMode
            case .maintenance: return WikiModeCopy.maintenance
            }
        }
    }

    /// The three modes, in the order both clients list them (`WIKI_MODE_ORDER`).
    public static let modes: [WikiReviewMode] = [.manual, .tiered, .automatic]
    /// The mode a space is made with, which the list tags `default` (`WIKI_DEFAULT_REVIEW_MODE`).
    public static let defaultMode: WikiReviewMode = .tiered

    /// The mode a space runs in: the one its settings name, and `manual` for one that names none — a
    /// space made before review modes existed (contract `space.settings.reviewMode.unset`).
    public static func mode(of settings: WikiSpaceSettings?) -> WikiReviewMode {
        guard let mode = settings?.reviewMode, mode != .unknown else { return .manual }
        return mode
    }

    /// What the page says when the space changed its own mode, while that is still its mode
    /// (`wikiModeFallback`).
    public static func modeFallback(_ settings: WikiSpaceSettings?, timeZone: TimeZone = .current) -> String? {
        let mode = mode(of: settings)
        let on = settings?.reviewModeChangedAt.flatMap { monthDay($0, timeZone: timeZone) }
        let when = on.map { " on \($0)" } ?? ""
        switch settings?.reviewModeChangedBy {
        case .verification? where mode == .tiered:
            return "Automatic switched itself back to Tiered\(when): the check rejected more than 30% of the last 50 changes. Choose Automatic again when you want it back."
        case .spotChecks? where mode == .manual:
            return "The spot checks switched this space back to Manual\(when): you rejected more than 30% of the last 10. Choose another mode when you want it back."
        default:
            return nil
        }
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private static func components(_ iso: String, timeZone: TimeZone) -> DateComponents? {
        guard let date = RelativeTime.parse(iso) else { return nil }
        return Calendar(identifier: .gregorian).dateComponents(in: timeZone, from: date)
    }

    /// `Sep 27` (`wikiMonthDay`).
    public static func monthDay(_ iso: String, timeZone: TimeZone = .current) -> String? {
        guard let parts = components(iso, timeZone: timeZone), let month = parts.month, let day = parts.day else { return nil }
        return "\(months[month - 1]) \(day)"
    }

    /// `Sep 28, 07:41`: when a run was recorded (`wikiRunWhen`).
    public static func runWhen(_ iso: String, timeZone: TimeZone = .current) -> String {
        guard let parts = components(iso, timeZone: timeZone), let month = parts.month, let day = parts.day,
              let hour = parts.hour, let minute = parts.minute else { return "" }
        return "\(months[month - 1]) \(day), \(String(format: "%02d", hour)):\(String(format: "%02d", minute))"
    }

    /// A workspace as the picker lists it: its name, and the runner it lives on (`wikiWorkspaceLabel`).
    public static func workspaceLabel(name: String?, runner: String?) -> String {
        let named = (name?.isEmpty == false ? name : nil) ?? "—"
        guard let runner, !runner.isEmpty else { return named }
        return "\(named) · \(runner)"
    }

    /// A provider as the picker lists it: its slug, and the model it runs when it names one.
    public static func providerLabel(_ provider: String, model: String?) -> String {
        guard let model, !model.isEmpty else { return provider }
        return "\(provider) · \(model)"
    }

    /// The three ways a look-back is picked, in the order both clients list them: none, some days, all of
    /// history (`WIKI_LOOKBACK_CHOICES`).
    public enum LookbackChoice: String, CaseIterable, Sendable {
        case now, days, all
    }

    /// The pick a look-back setting shows (`wikiLookbackChoice`).
    public static func lookbackChoice(_ days: Int?) -> LookbackChoice {
        guard let days else { return .all }
        return days == 0 ? .now : .days
    }

    /// The setting a pick writes: 0 from now on, nil all of history, and `days` for the days picked
    /// (`wikiLookbackDays`).
    public static func lookbackDays(_ choice: LookbackChoice, days: Int) -> Int? {
        switch choice {
        case .now:  return 0
        case .days: return days
        case .all:  return nil
        }
    }

    /// The days `Last … days` starts on: the setting's own when it looks back some days, else the default's
    /// (`wikiLookbackDaysOffered`).
    public static func lookbackDaysOffered(_ days: Int?) -> Int {
        if let days, days > 0 { return days }
        return WikiMaintenanceSettings.default.lookbackDays!
    }

    // MARK: an entry's marks

    /// Whether the owner's two answers apply: live, and applied by a mode with nobody vouching for it
    /// (`wikiEntryAnswerable`).
    public static func answerable(status: WikiEntryStatus?, trust: WikiTrust?) -> Bool {
        status == .active && (trust == .auto || trust == .unreviewed)
    }

    /// Confirm is for what agents are not sent yet; an Auto entry has Reject alone (`wikiCanConfirm`).
    public static func canConfirm(status: WikiEntryStatus?, trust: WikiTrust?) -> Bool {
        answerable(status: status, trust: trust) && trust == .unreviewed
    }

    /// The bar under an entry's head: its tone, its mark's word, and what that means for agents.
    public struct Banner: Equatable, Sendable {
        public let tone: WikiTone
        public let lead: String
        public let text: String

        public init(tone: WikiTone, lead: String, text: String) {
            self.tone = tone
            self.lead = lead
            self.text = text
        }
    }

    /// The bar an entry's page draws, or none for an entry no mode applied (`wikiMarkBanner`).
    public static func banner(status: WikiEntryStatus?, trust: WikiTrust?, tainted: Bool) -> Banner? {
        guard answerable(status: status, trust: trust) else { return nil }
        if tainted { return Banner(tone: .amber, lead: WikiCopy.webDerived, text: WikiModeCopy.bannerWebDerived) }
        if trust == .auto { return Banner(tone: .green, lead: WikiCopy.trustLabel(.auto), text: WikiModeCopy.bannerAuto) }
        return Banner(tone: .muted, lead: WikiCopy.trustLabel(.unreviewed), text: WikiModeCopy.bannerUnreviewed)
    }

    /// What Where it's used says first: an Unreviewed entry is not sent.
    public static func whereUsedNote(status: WikiEntryStatus?, trust: WikiTrust?) -> String? {
        status == .active && trust == .unreviewed ? WikiModeCopy.notSentUnreviewed : nil
    }

    /// The bar's second line: who checked it and what they said, when known, then who applied it and
    /// when (`wikiCheckedLine`).
    public static func checkedLine(verdict: WikiVerificationVerdict?, model: String?, tainted: Bool,
                                   who: String?, when: String?) -> String {
        var parts: [String] = []
        if let verdict, let model {
            parts.append("Checked by \(model): \(WikiModeCopy.verdictWord(verdict))")
            if tainted { parts.append(WikiModeCopy.cappedAtUnreviewed) }
        }
        if let who { parts.append(when.map { "\(who), \($0)" } ?? who) }
        return parts.joined(separator: " · ")
    }

    // MARK: one run

    /// Whether an op's effect stands from the run itself (`wikiOpApplied`).
    public static func opApplied(_ op: WikiChangesetOp) -> Bool {
        if op.decision == .autoApplied { return true }
        guard op.appliedByMode != nil else { return false }
        return (op.decision == .pending && op.spotCheck == true) || op.decision == .accepted || op.decision == .edited
    }

    /// Whether a changeset is a run a person can take back: some op of it was applied by its review mode,
    /// which its read says as `appliedByMode` and the timeline as each item's `changesetAppliedByMode`
    /// (`wikiIsRun`).
    public static func isRun(appliedByMode: WikiReviewMode?) -> Bool { appliedByMode != nil }

    public static func isRun(_ run: WikiChangesetView) -> Bool { isRun(appliedByMode: run.appliedByMode) }

    /// One entry a run changed, as its page lists it.
    public struct RunRow: Equatable, Sendable, Identifiable {
        public let op: WikiChangesetOp
        public let entryId: String?
        public let title: String
        public let summary: String
        /// The entry's trust as it stands now — none once it has ended — else what the op's verdict
        /// applied it with.
        public let trust: WikiTrust?
        public var id: String { op.id }
    }

    /// What one run did (`WikiRunSummary`): the server's counts, its entries grouped, and what Revert
    /// run… would undo.
    public struct RunSummary: Equatable, Sendable {
        public var applied = 0
        public var auto = 0
        public var unreviewed = 0
        public var rejectedByCheck = 0
        public var toReview = 0
        public var added: [RunRow] = []
        public var amended: [RunRow] = []
        public var reinforced: [RunRow] = []
        /// Whether the server says Revert run… would take anything back now.
        public var revertible = false
        public var revertAdds = 0
        public var revertAmends = 0

        /// How many changes the revert undoes, as its dialog says.
        public var revertTotal: Int { revertAdds + revertAmends }
    }

    /// One run as its read answers it: the server's counts and what Revert would undo, and its entries
    /// grouped Added / Amended / Reinforced (`wikiRunSummary`).
    public static func runSummary(_ run: WikiChangesetView) -> RunSummary {
        var byID: [String: WikiEntry] = [:]
        for entry in run.entries { byID[PublicID.storageKey(entry.id)] = entry }
        var summary = RunSummary()
        summary.applied = run.counts.applied
        summary.auto = run.counts.auto
        summary.unreviewed = run.counts.unreviewed
        summary.rejectedByCheck = run.counts.rejectedByCheck
        summary.toReview = run.counts.toReview
        summary.revertible = run.revertible
        summary.revertAdds = run.revert?.adds ?? 0
        summary.revertAmends = run.revert?.amends ?? 0
        for op in (run.changeset.ops ?? []).sorted(by: { ($0.seq ?? 0) < ($1.seq ?? 0) }) {
            guard opApplied(op) else { continue }
            let row = runRow(op, byID)
            switch op.op {
            case .add?:       summary.added.append(row)
            case .amend?:     summary.amended.append(row)
            case .reinforce?: summary.reinforced.append(row)
            default:          break
            }
        }
        return summary
    }

    private static func runRow(_ op: WikiChangesetOp, _ entries: [String: WikiEntry]) -> RunRow {
        let entryId = op.op == .add || op.op == .supersede ? (op.resultEntryId ?? op.entryId) : op.entryId
        let entry = entryId.flatMap { entries[PublicID.storageKey($0)] }
        let draft = op.payload?["entry"] ?? op.payload?["changes"]
        let verdictTrust: WikiTrust?
        switch op.verification?.verdict {
        case .supported?: verdictTrust = .auto
        case .partial?:   verdictTrust = .unreviewed
        default:          verdictTrust = nil
        }
        // An entry that has ended since (retired with its run, rejected) wears no mark.
        let trust: WikiTrust?
        if let entry { trust = entry.status == .active ? entry.trust : nil } else {
            trust = op.tainted == true && verdictTrust != nil ? .unreviewed : verdictTrust
        }
        return RunRow(op: op, entryId: entryId,
                      title: entry?.title ?? draft?["title"]?.stringValue ?? "—",
                      summary: entry?.summary ?? draft?["summary"]?.stringValue ?? "",
                      trust: trust)
    }

    /// The run's counts in a line (`wikiRunCounts`).
    public static func runCounts(_ summary: RunSummary) -> [String] {
        var parts: [String] = []
        if summary.auto > 0 { parts.append("\(summary.auto) \(WikiCopy.trustLabel(.auto))") }
        if summary.unreviewed > 0 { parts.append("\(summary.unreviewed) \(WikiCopy.trustLabel(.unreviewed))") }
        if summary.rejectedByCheck > 0 { parts.append(WikiModeCopy.rejectedByCheck(summary.rejectedByCheck)) }
        if summary.toReview > 0 { parts.append(WikiModeCopy.toReview(summary.toReview)) }
        return parts
    }

    /// What the Revert dialog says it will do (`wikiRevertBody`).
    public static func revertBody(_ summary: RunSummary) -> String {
        let total = summary.revertTotal
        var clauses: [String] = []
        if summary.revertAdds > 0 {
            clauses.append("\(summary.revertAdds) added \(summary.revertAdds == 1 ? "entry is" : "entries are") withdrawn")
        }
        if summary.revertAmends > 0 {
            clauses.append("\(summary.revertAmends) amended \(summary.revertAmends == 1 ? "one goes back to its" : "ones go back to their") previous revision")
        }
        let head = "The \(total) change\(total == 1 ? "" : "s") it applied \(total == 1 ? "is" : "are") undone"
        let body = clauses.isEmpty ? head : "\(head): \(clauses.joined(separator: " and "))"
        return "\(body). Agents stop getting \(total == 1 ? "it" : "them")."
    }

    // MARK: Recently changed

    /// A row of Recently changed: one op, or every op of a run, which opens by its changeset's id
    /// (`WikiRecentRow`).
    public enum RecentRow: Equatable, Sendable, Identifiable {
        case op(WikiTimelineItem)
        case run(changesetId: String, origin: WikiChangesetOrigin?, at: String?, items: [WikiTimelineItem])

        public var id: String {
            switch self {
            case .op(let item):                       return "op:\(item.opId)"
            case .run(let changesetId, _, _, _):      return "run:\(PublicID.storageKey(changesetId))"
            }
        }
    }

    /// The feed with every run folded into one row at the place of its newest change, by the changeset
    /// each item names; an op of no run stays a row of its own (`wikiRecentRows`).
    public static func recentRows(_ items: [WikiTimelineItem]) -> [RecentRow] {
        var rows: [RecentRow] = []
        var at: [String: Int] = [:]
        for item in items {
            guard let changesetId = item.changesetId, isRun(appliedByMode: item.changesetAppliedByMode) else {
                rows.append(.op(item))
                continue
            }
            let key = PublicID.storageKey(changesetId)
            if let index = at[key], case .run(let id, let origin, let when, let held) = rows[index] {
                rows[index] = .run(changesetId: id, origin: origin, at: when, items: held + [item])
                continue
            }
            at[key] = rows.count
            rows.append(.run(changesetId: changesetId, origin: item.origin, at: item.at, items: [item]))
        }
        return rows
    }

    // MARK: a challenge

    /// One anchor that no longer holds, in the words the server's own challenge reason uses.
    public struct BrokenAnchor: Equatable, Sendable {
        public let state: WikiAnchorState
        public let label: String

        public init(state: WikiAnchorState, label: String) {
            self.state = state
            self.label = label
        }
    }

    /// The anchors a challenge is about: every one whose last check found it changed or missing
    /// (`wikiBrokenAnchors`).
    public static func brokenAnchors(_ anchors: [WikiAnchor]?) -> [BrokenAnchor] {
        (anchors ?? []).compactMap { anchor in
            guard let state = anchor.check?.state, state == .changed || state == .missing else { return nil }
            return BrokenAnchor(state: state, label: anchorWords(anchor))
        }
    }

    /// `path src/a.ts`, `symbol foo in src/a.ts`, `commit 1588c3b` (`wikiAnchorWords`).
    public static func anchorWords(_ anchor: WikiAnchor) -> String {
        switch anchor.type {
        case .path?:   return "path \(anchor.path ?? "")"
        case .symbol?: return "symbol \(anchor.symbol ?? "") in \(anchor.path ?? "")"
        case .commit?: return "commit \(WikiLogic.shortSha(anchor.sha ?? ""))"
        default:       return "\(anchor.type?.rawValue ?? "unknown") anchor"
        }
    }

    /// The ref the broken anchors were checked on — the newest check among them (`wikiChallengeRef`).
    public static func challengeRef(_ anchors: [WikiAnchor]?) -> String? {
        (anchors ?? [])
            .compactMap(\.check)
            .filter { $0.state == .changed || $0.state == .missing }
            .sorted { ($0.at ?? "") > ($1.at ?? "") }
            .first?.ref
    }
}
