import Foundation

/// One row of the Wiki's contents list: the space's name (only where there is one) and the directory
/// rows. The list draws one row per case through one ForEach — the directory's own rows are a child
/// view, so the ForEach closure holds no branch.
public enum WikiContentsListRow: Equatable, Sendable, Identifiable {
    case head
    case contents

    public var id: String {
        switch self {
        case .head: "head"
        case .contents: "contents"
        }
    }
}

public enum WikiContentsListLogic {
    /// The directory as a single block: what the phone's Contents sheet lists.
    public static let sheetRows: [WikiContentsListRow] = [.contents]

    /// The middle column: the space's name first when a space is in view, then the directory.
    public static func columnRows(hasSpace: Bool) -> [WikiContentsListRow] {
        hasSpace ? [.head, .contents] : [.contents]
    }
}
