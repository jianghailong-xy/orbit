import SwiftUI
import OrbitKit

// A failed landing fixed by the task's own session (contract revision 42, §12.5, §12.7), as the owner
// ruled it on docs/mocks/landing-fix-own-session (iPhone 02 b–d, web 06 d–e). Every word and every
// reading is `LandingFix`'s in OrbitKit; these views only lay them out.

/// ② b ①: the landing-fix turn as the card it is, in the task's own session — not the reader's bubble,
/// since nobody typed it.
struct LandingFixCardView: View {
    let card: LandingFixCard
    var ts: String?
    var undelivered: Bool = false
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").font(.orbitMeta)
                Text(LandingFixCopy.provenance).font(.orbitMeta.weight(.bold)).lineLimit(1)
                Spacer(minLength: 6)
                Text(card.badge)
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.orange.opacity(0.14), in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.orange.opacity(0.35), lineWidth: 1))
            }
            .foregroundStyle(Color.orange)
            Text(card.heading)
                .font(.orbitProse.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            lead
            if !card.boxLines.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(card.boxLines.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.orbitMono).lineLimit(2).truncationMode(.middle)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("landing-fix-files")
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(card.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(index + 1).").monospacedDigit()
                        Text(step).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.orbitSubtext)
            Divider()
            footer
            if undelivered {
                Text(SessionMessageCard.undelivered).font(.orbitMeta).foregroundStyle(.orange)
            }
            if let onCancelQueued {
                Button(role: .destructive, action: onCancelQueued) { Text("Cancel") }
                    .font(.orbitMeta).buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12).strokeBorder(
                Color.orange.opacity(0.28),
                style: StrokeStyle(lineWidth: 1, dash: onCancelQueued != nil ? [4, 3] : []))
        )
        .orbitCardWidth()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("landing-fix-card")
    }

    /// `Conflict while rebasing onto the project branch at 41ac9e0. Nothing was pushed.` — the commit as
    /// code, the last sentence in bold.
    private var lead: some View {
        var text = AttributedString(card.lead)
        if let sha = card.sha {
            var code = AttributedString(" \(sha)")
            code.font = .orbitMono
            text += code
            text += AttributedString(".")
        }
        var pushed = AttributedString(" \(LandingFixCopy.nothingWasPushed)")
        pushed.font = .orbitSubtext.weight(.semibold)
        text += pushed
        return Text(text).font(.orbitSubtext).fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var footer: some View {
        let id = card.landingSessionId
        VStack(alignment: .leading, spacing: 4) {
            Text(card.footer).font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let id {
                LandingEntryLink(entry: .link(id))
                    .accessibilityIdentifier("landing-fix-open-landing")
            }
        }
    }
}

/// ② b ③: the one line the session gains once the fix it committed is queued to land again —
/// `Landing 4be19c2 again · Open landing ›`. Read off the session's own landing (`sourceLanding`): its
/// record's `FIXED_BY_SESSION` that this session asked for, which names the commit.
struct LandingFixAgainLine: View {
    let console: ConsoleModel
    @Environment(AppModel.self) private var app
    @State private var landing: SessionLandingView?

    var body: some View {
        if let source = console.worktree.detail?.sourceLanding, !source.landingSessionId.isEmpty {
            let asked = (landingID: source.landingSessionId, state: source.state)
            // A stack, not a Group: until the line exists there is nothing else to hang the read on, and an
            // empty Group is no view, so its `.task` would never run.
            VStack(spacing: 0) {
                Color.clear.frame(height: 0)
                if let line = LandingFix.againLine(landing, by: console.sessionID) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Color.accentColor)
                        Text(line).foregroundStyle(.secondary)
                        LandingEntryLink(entry: .link(asked.landingID))
                    }
                    .font(.orbitLabel)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color.primary.opacity(0.05), in: Capsule())
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, .composerBandGap)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("landing-fix-again")
                }
            }
            // Read again whenever the session's own landing moves.
            .task(id: "\(asked.landingID)|\(asked.state)") {
                await read(asked.landingID)
            }
        }
    }

    private func read(_ id: String) async {
        guard let baseURL = app.baseURL else { return }
        let api = APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
        if let detail = try? await api.sessionDetail(id) { landing = detail.landing }
    }
}

/// ② c ②, d ②: one of the rows revision 42 adds to a landing's record, drawn apart from the steps on
/// the board's violet wash.
struct LandingFixRowView: View {
    let row: LandingFixRow

    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(time).font(.orbitMeta).foregroundStyle(.tertiary).monospacedDigit()
                .frame(width: 38, alignment: .leading)
            Image(systemName: symbol).font(.orbitMeta.weight(.semibold)).foregroundStyle(Color.purple)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                line.fixedSize(horizontal: false, vertical: true)
                if let detail = row.detail {
                    Text(detail).font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Color.purple.opacity(row.kind == .returned ? 0 : 0.08), in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture {
            if let id = row.sessionId, let url = URL(string: "orbit-session:\(PublicID.toPublic(id))") {
                openURL(url)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("landing-fix-row:\(row.kind.rawValue)")
    }

    private var symbol: String {
        switch row.kind {
        case .handed: return "person"
        case .fixed: return "arrow.up"
        case .returned: return "arrow.right"
        }
    }

    private var time: String {
        RelativeTime.parse(row.at).map { ProjectPage.landingClockTime($0) } ?? ""
    }

    private var line: Text {
        var text = AttributedString(row.head)
        text.font = .orbitLabel.weight(row.kind == .fixed ? .regular : .semibold)
        if let sha = row.sha {
            var code = AttributedString(" \(sha)")
            code.font = .orbitMono
            text += code
        }
        if let rest = row.rest {
            var tail = AttributedString(" · \(rest)")
            tail.font = .orbitLabel
            text += tail
        }
        return Text(text)
    }
}

/// ② c ①: the Fixing card's who-line and its two doors — the task's own session first.
struct LandingFixingDoors: View {
    let landing: SessionLandingView
    let now: Date
    let act: (LandingMenuAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "person").foregroundStyle(Color.accentColor)
                (Text(LandingFixCopy.theTasksSession).fontWeight(.semibold)
                 + Text(" ") + Text(LandingFix.fixingWho(landing, now: now)).foregroundColor(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.orbitMeta)
            HStack(spacing: 8) {
                Button(LandingFixCopy.openSession) { act(.openSourceSession) }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .accessibilityIdentifier("landing-fix-open-session")
                if landing.subject == "TASK", let task = landing.taskId, !task.isEmpty {
                    Button(LandingPageCopy.openTask) { act(.openTask) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("landing-fixing")
    }
}

/// ② d ①: what the task's session did before it handed the failure back, and its last words.
struct LandingFixHandBackView: View {
    let handBack: LandingFixHandBack

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(handBack.leadLine).font(.orbitMeta).foregroundStyle(.secondary)
            if let words = handBack.lastMessage {
                Text("\u{201C}\(words)\u{201D}").font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("landing-fix-hand-back")
    }
}

/// Web board 06 d: one Open items row under "Being fixed by its session" — the failure, who has it,
/// and the way into that session.
struct BeingFixedItemRow: View {
    let row: ProjectOpenItemRow
    let taskTitle: String?
    let now: Date

    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            PlatformHaptics.tap()
            if let id = row.workSession?.sessionId, let url = URL(string: "orbit-session:\(PublicID.toPublic(id))") {
                openURL(url)
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "person").font(.orbitMeta).foregroundStyle(Color.purple)
                VStack(alignment: .leading, spacing: 2) {
                    Text(LandingFix.itemHead(row, taskTitle: taskTitle))
                        .font(.orbitSubtext).foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(LandingFix.itemDetail(row, now: now))
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(LandingFixCopy.openSessionLink) ›")
                        .font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.purple)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("being-fixed:\(row.itemId)")
    }
}
