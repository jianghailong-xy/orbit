import SwiftUI
import OrbitKit

/// The conversation's last row while it is at rest (`RecapCard`; the web's `SessionRecapCard`): the
/// recap its list row reads in one line, here whole, with when it was written and a way to write it
/// again now. Where it sits and when it steps aside is `TranscriptView`'s business; this is the card
/// (docs/mocks/session-recap-display/04-decided, ③ for its measurements).
struct RecapCardView: View {
    @Environment(AppModel.self) private var app
    let card: RecapCard
    let sessionID: String
    @State private var refreshing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // The Settings row's own glyph: the switch that governs this card.
                Image(systemName: "text.alignleft")
                (Text(RecapCard.word).fontWeight(.semibold) + Text(card.when.map { " · \($0)" } ?? ""))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button(action: refresh) {
                    Group {
                        if refreshing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise").font(.orbitControlGlyph)
                        }
                    }
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(refreshing)
                .help(RecapCard.refresh)
                .accessibilityLabel(RecapCard.refresh)
                .padding(.trailing, -8)
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            Text(card.text)
                .font(.orbitSubtext)
                .foregroundStyle(.primary)
                .opacity(refreshing ? 0.45 : 1)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }

    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        Task { @MainActor in
            if let notice = await app.refreshRecap(sessionID) {
                app.showToast(notice.text, tone: notice.failed ? .error : .info)
            }
            refreshing = false
        }
    }
}
