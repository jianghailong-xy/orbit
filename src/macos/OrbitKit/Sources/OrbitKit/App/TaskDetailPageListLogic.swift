import Foundation

/// The task page's blocks in the order the page draws them (web `TaskDetailPanel`, block for block).
/// The page's List draws one row per block through one ForEach; a block with nothing to say is not
/// in the array, so the ForEach closure holds no branch.
public enum TaskDetailPageListRow: String, Sendable, Identifiable {
    case header
    case verifier
    case now
    case evidence
    case landing
    case acceptance
    case brief
    case plan
    case runsWith
    case inputs
    case attribution
    case followedBy
    case activity

    public var id: String { rawValue }
}

public enum TaskDetailPageListLogic {
    public static func rows(hasVerifier: Bool, hasLiveRun: Bool, hasEvidence: Bool, hasLanding: Bool,
                            hasDependencies: Bool, hasInputs: Bool, hasAttribution: Bool,
                            hasFollowers: Bool) -> [TaskDetailPageListRow] {
        var rows: [TaskDetailPageListRow] = [.header]
        if hasVerifier { rows.append(.verifier) }
        if hasLiveRun { rows.append(.now) }
        if hasEvidence { rows.append(.evidence) }
        if hasLanding { rows.append(.landing) }
        rows += [.acceptance, .brief]
        if hasDependencies { rows.append(.plan) }
        rows.append(.runsWith)
        if hasInputs { rows.append(.inputs) }
        if hasAttribution { rows.append(.attribution) }
        if hasFollowers { rows.append(.followedBy) }
        rows.append(.activity)
        return rows
    }
}

/// The fields of the Run settings sheet, in the order it draws them. The suggested tier only when
/// the coordinator's smart selection is on, so it is a row the logic adds rather than an `if` in the
/// sheet's ForEach.
public enum TaskEnvelopeListRow: String, Sendable, Identifiable {
    case assignee
    case suggested
    case engine
    case provider
    case model
    case list
    case startAt

    public var id: String { rawValue }
}

public enum TaskEnvelopeListLogic {
    public static func rows(smartSelection: Bool) -> [TaskEnvelopeListRow] {
        [.assignee] + (smartSelection ? [.suggested] : [])
            + [.engine, .provider, .model, .list, .startAt]
    }
}
