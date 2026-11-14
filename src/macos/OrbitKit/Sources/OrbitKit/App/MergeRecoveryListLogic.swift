import Foundation

/// One row of the merge-recovery review: the header, the repair row, and then either the landed
/// summary or the blocks that ask for a decision. One array, so the List holds one ForEach and no
/// branch of its own.
public enum MergeRecoveryListRow: Equatable, Sendable, Identifiable {
    case header
    case repair
    case landed
    case review

    public var id: String {
        switch self {
        case .header: "header"
        case .repair: "repair"
        case .landed: "landed"
        case .review: "review"
        }
    }
}

public enum MergeRecoveryListLogic {
    public static func rows(hasRepair: Bool, landed: Bool) -> [MergeRecoveryListRow] {
        var rows: [MergeRecoveryListRow] = [.header]
        if hasRepair { rows.append(.repair) }
        rows.append(landed ? .landed : .review)
        return rows
    }
}

/// One row of the candidate diff sheet: the text standing in when there are no changed files, or the
/// files themselves.
public enum CandidateDiffListRow: Equatable, Sendable, Identifiable {
    case text
    case files

    public var id: String {
        switch self {
        case .text: "text"
        case .files: "files"
        }
    }
}

public enum CandidateDiffListLogic {
    public static func rows(hasFiles: Bool) -> [CandidateDiffListRow] {
        [hasFiles ? .files : .text]
    }
}

/// One row of the branches checklist: the source, the target, the commits already on origin, and the
/// candidate's own refs, each present only when it has something to say.
public enum RecoveryBranchesListRow: Equatable, Sendable, Identifiable {
    case source
    case target
    case remoteCommits
    case candidate

    public var id: String {
        switch self {
        case .source: "source"
        case .target: "target"
        case .remoteCommits: "remote-commits"
        case .candidate: "candidate"
        }
    }
}

public enum RecoveryBranchesListLogic {
    public static func rows(hasRemoteCommits: Bool, hasCandidate: Bool) -> [RecoveryBranchesListRow] {
        var rows: [RecoveryBranchesListRow] = [.source, .target]
        if hasRemoteCommits { rows.append(.remoteCommits) }
        if hasCandidate { rows.append(.candidate) }
        return rows
    }
}
