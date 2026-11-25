import SwiftUI
import OrbitKit

/// A session's marks (`SessionDisplay.marks`), drawn after its state word: one small labelled capsule
/// per fact, in the mark's own tone. `more` is a phone row's "+N" for the marks it leaves out.
struct SessionMarkPills: View {
    let marks: [SessionMark]
    var more: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            ForEach(marks, id: \.self) { SessionMarkPill(mark: $0) }
            if let more {
                Text(more).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .fixedSize()
    }
}

struct SessionMarkPill: View {
    let mark: SessionMark

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: mark.symbol).imageScale(.small).fontWeight(.semibold)
            Text(mark.word).lineLimit(1)
        }
        .font(.orbitMeta)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .foregroundStyle(color)
        .background(color.opacity(0.1), in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mark.word)
    }

    private var color: Color {
        switch mark.tone {
        case .warning: return .orange
        case .error:   return .red
        case .success: return .green
        case .brand:   return .blue
        case .neutral: return .secondary
        }
    }
}
