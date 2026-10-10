import SwiftUI
import OrbitKit

extension SessionLine {
    /// The line as one text run, the way a session row draws its second line: the recap's muted
    /// label, a space, then the text. Built by concatenation (not an HStack) so the label and the
    /// text truncate together as one line, the way web's inline spans do. Lines with no label — all
    /// but the recap — are the text alone. Every place that shows a session's recap draws it with
    /// this: the session list's rows, the project row, the chat page's header and the project
    /// page's coordinator card.
    var listText: Text {
        guard let label else { return Text(text) }
        return Text("\(label) ").foregroundStyle(.tertiary) + Text(text)
    }

    /// The colour a session row gives the line: blue while it works, amber while it waits on you,
    /// secondary for everything else (`AgentSessionRow.lineColor`).
    var listColor: Color {
        switch tone {
        case .preview, .queued, .background, .watching, .review: return .secondary
        case .running: return .blue
        case .approval: return .orange
        }
    }
}
