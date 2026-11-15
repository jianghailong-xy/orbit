import Foundation

/// The project page's blocks, in the order the page draws them. The page's List draws exactly one
/// row per block through one ForEach; a block with nothing to say draws no row (its own builder
/// returns an empty view), so the array is the same for every project.
public enum ProjectPageListRow: String, CaseIterable, Sendable, Identifiable {
    case header
    case openItems
    case overview
    case coordinator
    case runSettings
    case goal
    case graph
    case blockers
    case runQueue
    case criteria
    case instructions
    case tasks
    case crossings

    public var id: String { rawValue }
}

public enum ProjectPageListLogic {
    public static let rows = ProjectPageListRow.allCases
}

/// The open-items sheet's rows: the open items themselves, and — when the sheet has nothing else to
/// show — the sentence that says so. One array, so the sheet's List holds one ForEach.
public enum ProjectOpenItemsListRow: Equatable, Sendable, Identifiable {
    case openItems
    case empty

    public var id: String {
        switch self {
        case .openItems: "open-items"
        case .empty: "empty"
        }
    }
}

public enum ProjectOpenItemsListLogic {
    public static func rows(summaryCount: Int, hasStartRow: Bool,
                            hasDoneRow: Bool) -> [ProjectOpenItemsListRow] {
        [.openItems] + (summaryCount == 0 && !hasStartRow && !hasDoneRow ? [.empty] : [])
    }
}
