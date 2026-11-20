import Foundation

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   THE LANDING CHECK'S THREE VALUES, WHO SET IT, AND THE COORDINATOR'S CHANGES — THIS CLIENT'S HALF
   OF WEB'S `lib/landingCheck.ts` (revision 42 part two, rulings D3–D7, D9),
   `ProjectRunSettings.tsx`'s landing check row and `ProjectLandingChanges.tsx`
   ─────────────────────────────────────────────────────────────────────────────────────────────

   The landing check is one of three: the merge check (nothing set, §11 K1), a command, or No check
   (`NONE`, §12.15 P-C1), which is its own value written by name. Under it, who set it last
   (`integration.landingCheck.setBy/setAt`). Settings' "Coordinator’s changes" row opens the list
   `project_get.settingChanges` gives, newest first; Revert is offered exactly where the server says
   `revertible`, and puts the old value back with `POST /projects/:id/setting-changes/:id/revert`.
   Every word is the browser's: `LandingCheckTests` reads `lib/landingCheck.ts` back.
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/// Which of the three the landing check is — web's `LandingCheckMode`.
public enum LandingCheckMode: String, CaseIterable, Equatable, Sendable {
    case mergeCheck = "MERGE_CHECK"
    case command = "COMMAND"
    /// No check (`NONE`) — not `none`, which would read as an Optional's.
    case noCheck = "NONE"

    /// The landing check as the settings read it: `NONE` is its own value, a command is a command,
    /// and nothing set falls back to the merge check (§11 K1) — web's `landingCheckModeOf`.
    public static func of(_ view: ProjectIntegrationView) -> LandingCheckMode {
        let command = view.landingCheck.map { $0.command } ?? view.landingCheckCommand
        if command == "NONE" { return .noCheck }
        return (command ?? "").isEmpty ? .mergeCheck : .command
    }

    /// Its segment's label.
    public var label: String {
        switch self {
        case .mergeCheck: return LandingModeCopy.mergeCheck
        case .command: return LandingModeCopy.command
        case .noCheck: return LandingModeCopy.none
        }
    }
}

/// Web's `LANDING_MODE_COPY`.
public enum LandingModeCopy {
    public static let mergeCheck = "Merge check"
    public static let command = "Command"
    public static let none = "No check"
    public static let noneHead = "No check."
    public static let noneBody = "Tasks land with only their own acceptance. The merge check still runs before main."
    public static let commandNote = "Changes the coordinator makes are listed under Coordinator’s changes."
    public static let whoCanSet = "Who can set it"
}

/// Web's `LANDING_CHECK_ORIGIN_COPY`: the badge a landing check's `setBy` wears (D3, D9), and a
/// change's `origin`.
public enum LandingCheckOriginCopy {
    public static let owner = "You"
    public static let coordinator = "Coordinator"
    public static let card = "Approved on a card"
    public static let start = "Set at start"

    public static func badge(_ setBy: LandingCheckSetBy) -> String {
        switch setBy {
        case .owner: return owner
        case .coordinator: return coordinator
        case .card: return card
        case .start: return start
        }
    }

    /// Who set it and when, under the landing check: "Coordinator · set 2h ago".
    public static func line(_ check: ProjectLandingCheck?, now: Date = Date()) -> String? {
        guard let setBy = check?.setBy else { return nil }
        guard let at = check?.setAt, let ago = RelativeTime.format(at, now: now) else { return badge(setBy) }
        return "\(badge(setBy)) · set \(ago)"
    }

    /// One line under "Who can set it": a badge, and what it means.
    public struct Note: Equatable, Sendable, Identifiable {
        public let by: LandingCheckSetBy
        public let note: String
        public var id: String { by.rawValue }
    }

    /// Web's `LANDING_CHECK_ORIGIN_NOTES`, in its order: who can set it, under No check.
    public static let notes: [Note] = [
        Note(by: .owner, note: "Anything you set; the coordinator then needs a card to change it."),
        Note(by: .coordinator, note: "No card, while the merge check exists."),
        Note(by: .card, note: "A change you confirmed on a card."),
        Note(by: .start, note: "The coordinator proposed it and you pressed Start; it may still change without a card. A value you typed on the start card reads as You."),
    ]
}

/// Web's `CHANGES_COPY`, `changesRowLabel` and `revertedLine`.
public enum LandingChangesCopy {
    public static let title = "Coordinator’s changes"
    public static let intro = "What the coordinator changed on its own since the project started. Revert puts the old value back and takes the field away from the coordinator: it needs a card from then on."
    public static let empty = "The coordinator has not changed anything on its own."
    public static let landingCheck = "Landing check"
    public static let checkExempt = "Check exempt"
    public static let usesMergeCheck = "Uses merge check"
    public static let noCheck = "No check"
    public static let exempt = "exempt"
    public static let notExempt = "not exempt"
    public static let revert = "Revert"
    public static let yourChange = "Your change"
    public static let yourChangeNothing = "Your change · nothing to revert"
    public static let confirmTitle = "Revert this change?"
    public static let confirmConsequence = "The coordinator can no longer change this field without a card."
    public static let cancel = "Cancel"
    /// The task link a task's exemption row carries.
    public static let openTask = "Open task"

    /// Settings' row into the list (D6): "1 change", "3 changes".
    public static func rowLabel(_ count: Int) -> String { "\(count) \(count == 1 ? "change" : "changes")" }
    public static func revertedLine(_ when: String) -> String {
        "Reverted by you · \(when) · coordinator needs a card for this field"
    }
}

/// Web's `TASK_EXEMPT_COPY` and `exemptCheckReason` (D5): a task's exemption from the landing check.
public enum TaskExemptCopy {
    public static let label = "Landing check"
    public static let badge = "Exempt"
    public static let remove = "Remove exemption"
    public static let skipped = "Skipped"
    public static let mergeCheckStillRuns = "Merge check before main"
    public static let stillRuns = "Still runs"
    public static func reason(_ reason: String) -> String { "Exempt: \(reason)" }
}

/// What the change list draws for each record — every part a field of `settingChanges`.
public enum LandingChanges {

    /// What a field's value reads as: a command (drawn as code), the merge check, No check, or a task
    /// exempt or not. `code` is true only for a command.
    public static func valueText(_ value: ProjectSettingChangeValue) -> (text: String, code: Bool) {
        switch value {
        case .landingCheck(let command, _, let none):
            if none { return (LandingChangesCopy.noCheck, false) }
            if let command, !command.isEmpty { return (command, true) }
            return (LandingChangesCopy.usesMergeCheck, false)
        case .taskExempt(let exempt, _):
            return (exempt ? LandingChangesCopy.exempt : LandingChangesCopy.notExempt, false)
        }
    }

    /// The field a row names.
    public static func what(_ change: ProjectSettingChange) -> String {
        change.field == .taskLandingCheckExempt ? LandingChangesCopy.checkExempt : LandingChangesCopy.landingCheck
    }

    /// The badge a change's origin wears.
    public static func origin(_ change: ProjectSettingChange) -> String {
        switch change.origin {
        case .coordinator: return LandingCheckOriginCopy.coordinator
        case .card: return LandingCheckOriginCopy.card
        case .owner, .unknown: return LandingCheckOriginCopy.owner
        }
    }

    /// What a row offers at its end.
    public enum Action: Equatable, Sendable {
        /// The server says it can be put back.
        case revert
        /// The owner's own change, which nothing reverts.
        case note(String)
        case nothing
    }

    public static func action(_ change: ProjectSettingChange) -> Action {
        if change.revertible { return .revert }
        if change.origin != .coordinator && change.revertsChangeId == nil { return .note(LandingChangesCopy.yourChangeNothing) }
        return .nothing
    }

    /// The confirmation's sentence: "Landing check goes back from make fast to Uses merge check."
    public static func confirmBody(_ change: ProjectSettingChange) -> String {
        "\(what(change)) goes back from \(valueText(change.newValue).text) to \(valueText(change.oldValue).text)."
    }
}

extension RunSettings {
    /// The landing check a Save writes, by the three values (D4) — web's `runSettingsWrites`, landing
    /// half: No check is written by name, and only when it is not already the value; the merge check
    /// and a command go through the command (null for the merge check), also when leaving No check;
    /// the timeout only with a check, and only when it moves. Nil when nothing moves.
    public static func landingCheckWrite(_ view: ProjectIntegrationView, mode: LandingCheckMode, command: String,
                                         timeout: Int?) -> UpdateProjectIntegrationRequest? {
        let landing: String? = mode == .command
            && !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? command : nil
        let stored = LandingCheckMode.of(view)
        var none: String?
        var write: String??
        if mode == .noCheck {
            if stored != .noCheck { none = "NONE" }
        } else if landing != view.landingCheckCommand || stored == .noCheck {
            write = .some(landing)
        }
        let budget: Int?? = mode != .noCheck && timeout != view.landingCheckTimeoutSeconds ? .some(timeout) : nil
        let body = UpdateProjectIntegrationRequest(landingCheckCommand: write, landingCheckTimeoutSeconds: budget,
                                                   landingCheck: none)
        return body.isEmpty ? nil : body
    }
}
