import Foundation

// How a task's detail says a row is judged: which method settles it, and — on the rows that have no
// work of their own — the check that does it. Both clients render this; the words are hand-mirrored
// from the browser's `components/TaskDetailPanel.tsx` and pinned there by
// `TaskJudgmentCopyParityTests`, because the two share no compiler and a sentence reworded at one
// end simply never appears at the other.

/// The browser's declarations, sentence for sentence.
public enum TaskJudgmentCopy {
    /// What the header button on a row with no work of its own says instead of Run.
    ///
    /// One statement for every state, because that statement is what the button cannot do: nothing
    /// here starts a run and nothing here can be pressed. It used to be the verifier's state, which
    /// read as a document the reader was being asked to fetch. What the check is doing is a fact
    /// about the check, and it is said where the check itself is shown: the card below.
    public static let gateActionLabel = "由复核判定"

    /// The chip under the title of a row that has no work of its own — the thing that is true of it
    /// and was nowhere on the page: no run of it can settle it.
    public static let gateChip = "闸门 · 本行没有自己的活"

    /// The judgment each completion criterion declares, in the chip's words. Keyed on the criterion
    /// because that is what a criterion is for: who settles the task, which is a different question
    /// from whether the task has work to do (`completionPolicy`).
    public static let completionCriterionChip: [String: String] = [
        "EXECUTABLE": "完成判定 · 验收命令",
        "VERIFICATION": "完成判定 · 独立复核",
        "EVIDENCE_JUDGMENT": "完成判定 · 证据判定",
        "OWNER_CONFIRMED": "完成判定 · 所有者确认",
    ]

    /// The hint under the button, per state of the check that settles the row.
    public static let verificationSubjectHint: [String: String] = [
        "MISSING": "还没有复核任务 —— 本行没有自己的活,而库里没有指向它的复核行。",
        "PENDING": "复核任务已建,还没有给出结论。",
        "RUNNING": "复核任务正在跑 —— 这一行由它的结论判定。",
        "BLOCKED": "复核任务被挡住了 —— 先把挡住它的东西解掉。",
        "FAILED": "复核结论是未通过 —— 这一行不会结算。",
        "PASSED": "复核已通过 —— 正在应用结果。",
    ]

    /// The card that names the check, the way into it, and the empty state a row with no check left
    /// reads — the same sentence its header hint carries, so the two cannot send a reader to
    /// different places.
    public static let verifierCardHeading = "复核任务"
    public static let verifierCardEntry = "查看"
    public static let verifierCardEmpty = verificationSubjectHint["MISSING"]!
}

/// The chip under a row's title, or null on a row that declares no judgment method.
public struct TaskJudgmentChip: Equatable, Sendable {
    /// A row with no work of its own, drawn apart from the method chips.
    public let isGate: Bool
    public let text: String
}

/// How the check that settles a row stands, in the card's three words. A verdict is the conclusion;
/// a check that has not written one yet reads Open whatever its run is doing, because whether a
/// conclusion exists is the only thing this badge answers.
public enum VerifierOutcome: String, Sendable, Equatable, CaseIterable {
    case pass, fail, open

    public var label: String {
        switch self {
        case .pass: return "PASS"
        case .fail: return "FAIL"
        case .open: return "Open"
        }
    }

    /// The pill the card draws it as, in the app's own state vocabulary: a conclusion that is good,
    /// one that is bad, or none yet.
    var pillKind: TaskPillKind {
        switch self {
        case .pass: return .done
        case .fail: return .failed
        case .open: return .open
        }
    }

    public static func of(_ verifier: TaskVerifierRef) -> VerifierOutcome {
        switch verifier.verdict {
        case "PASS":              return .pass
        case "FAIL", "INCONCLUSIVE": return .fail
        default:                  return .open
        }
    }
}

public enum TaskJudgment {
    /// The row a completion declaration owns: nothing dispatches it, because it has no work of its
    /// own. Clause for clause the server's Ready predicate (`manualRunnableTaskSql`) and the
    /// browser's `taskStartOwnedByCompletionDeclaration`.
    ///
    /// `completionCriterion` is deliberately not asked. A VERIFICATION criterion says an independent
    /// verdict settles this task — who finishes it, not whether it has anything to run — so a row
    /// can perfectly well run and still need another session to check it.
    public static func isGateRow(_ task: TaskItem) -> Bool {
        task.completionPolicy == "VERIFICATION_PASSED" && task.verifiesTaskId == nil
    }

    /// The chip under a row's title: a gate row says the thing that is true of it, and every other
    /// row names the method that settles it. Null on a row that declares no criterion — every write
    /// door requires one, so those predate the rule, and naming a method nobody declared would be
    /// the same kind of guess this whole surface exists to stop making.
    public static func chip(_ task: TaskItem) -> TaskJudgmentChip? {
        if isGateRow(task) { return TaskJudgmentChip(isGate: true, text: TaskJudgmentCopy.gateChip) }
        guard let text = TaskJudgmentCopy.completionCriterionChip[task.completionCriterion ?? ""] else {
            return nil
        }
        return TaskJudgmentChip(isGate: false, text: text)
    }

    /// The check as the card's badge: the same pill every other state in the app is drawn with, so
    /// a reader compares it against the row's own status without learning a second vocabulary.
    public static func pill(_ verifier: TaskVerifierRef) -> TaskPill {
        let outcome = VerifierOutcome.of(verifier)
        return TaskPill(kind: outcome.pillKind, label: outcome.label)
    }

    /// The hint under the header button on a gate row. An unknown state — a newer server's — gets
    /// the generic wording rather than nothing.
    ///
    /// The browser has one more sentence, for a DONE subject whose check has passed: the detail
    /// actions here draw no button at all once a task is DONE, so no reader is left waiting on an
    /// explanation of a press that is not on screen.
    public static func gateHint(_ verificationState: String?) -> String {
        TaskJudgmentCopy.verificationSubjectHint[verificationState ?? "PENDING"]
            ?? TaskJudgmentCopy.verificationSubjectHint["PENDING"]!
    }
}
