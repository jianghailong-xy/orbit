import SwiftUI
import OrbitKit

// A link to an object in this deployment, drawn as the object instead of as its address.
//
// One skeleton, four contents, and the two states a card can be in with nothing to show — all of it
// decided by `OrbitLinkCardContent` (OrbitKit), which is where every word on this card comes from.
// The view is only the drawing: the type's tile and name, a title, a progress meter, one or two
// lines of status, and — for a project — the row that says who coordinates it.
//
// The design is the owner's chosen mock — panel ② of the link-card effect drawing (iOS, 393×852pt):
// a white card, a hairline border and a 10pt radius in an agent's reply; embedded in the person's
// own bubble it takes the bubble's width, a tinted 20% border and an 8pt radius instead. It is drawn by a link
// that stands for itself — a pasted page URL of this deployment, or a reference on a line of its own
// — and never by a link written inside a sentence (see `OrbitLinkPlacement`).

struct OrbitLinkCardView: View {
    let ref: OrbitLinkRef
    /// Inside the person's bubble: the card fills the bubble at its 5pt inset, and wears the tint.
    var inBubble: Bool = false

    @Environment(AppModel.self) private var app: AppModel?
    /// In a phone's conversation, what the card opens is pushed over it (see `opensPagesOverConsole`).
    @Environment(\.opensPagesOverConsole) private var overConsole

    private var cards: OrbitLinkCards? { app?.linkCards }
    private var content: OrbitLinkCardContent {
        cards?.content(for: ref) ?? .loading(ref, host: "")
    }

    var body: some View {
        Button { open() } label: { card }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu { menu }
    }

    // MARK: the card

    private var card: some View {
        let content = self.content
        return VStack(alignment: .leading, spacing: 5) {
            head(content)
            if content.state == .ready {
                Text(content.title ?? "")
                    .font(.orbitProse.weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if !content.meter.isEmpty { OrbitLinkMeter(segments: content.meter) }
                ForEach(content.lines.indices, id: \.self) { line(content.lines[$0]) }
                if let foot = content.foot { footRow(foot) }
            } else {
                if content.state == .loading {
                    bar(0.78)
                    bar(0.46)
                } else {
                    Text(content.title ?? OrbitLinkCopy.notAvailable)
                        .font(.orbitProse.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(content.lines.indices, id: \.self) { line(content.lines[$0]) }
                }
                path(content.path)
            }
        }
        .padding(.top, 9)
        .padding(.bottom, 10)
        .padding(.horizontal, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.editorSurface, in: RoundedRectangle(cornerRadius: radius))
        .overlay {
            RoundedRectangle(cornerRadius: radius).strokeBorder(border, lineWidth: 1)
        }
        // In a reply the card is lifted off the transcript by its shadow; in the bubble it is a
        // panel of the bubble itself and has nothing to be lifted off.
        .shadow(color: inBubble ? .clear : .black.opacity(0.04), radius: 1, y: 1)
    }

    private var radius: CGFloat { inBubble ? 8 : 10 }
    private var border: Color {
        inBubble ? Color.accentColor.opacity(0.20) : Color.primary.opacity(0.16)
    }

    /// What the link is: its type's tile and name — and a wiki entry's kind beside it — and, for a
    /// task or a session, what state the object is in, in the words the app already uses for it
    /// (`TaskStatusPill`, `SessionStatusGlyph`); for a wiki entry, its trust, as the Wiki's own pages
    /// badge it.
    private func head(_ content: OrbitLinkCardContent) -> some View {
        HStack(spacing: 7) {
            tile(content)
            Text(content.typeName)
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 6)
            if let pill = content.pill {
                TaskStatusPill(pill: pill)
            } else if let glyph = content.sessionGlyph {
                OrbitLinkStatusPill(glyph: glyph)
            } else if let trust = content.wikiTrust, trust != .unknown {
                WikiBadge(text: WikiCopy.trustLabel(trust), tone: WikiLogic.trustTone(trust))
            }
        }
        .frame(height: 20)
    }

    private func tile(_ content: OrbitLinkCardContent) -> some View {
        Image(systemName: Self.symbol(content.kind))
            .font(.orbitMeta)
            .foregroundStyle(content.state == .unavailable ? Color.secondary : Color.accentColor)
            .frame(width: 20, height: 20)
            .background(content.state == .unavailable ? Color.primary.opacity(0.06)
                                                      : Color.accentColor.opacity(0.12),
                        in: RoundedRectangle(cornerRadius: 5))
    }

    /// One secondary line: an optional chip in front (the Coordinator badge), the line's own glyph,
    /// and the words. One line, truncated — a card says what it has to say in a glance.
    private func line(_ line: OrbitLinkCardContent.Line) -> some View {
        HStack(spacing: 5) {
            if let badge = line.badge {
                Text(badge)
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                    .lineLimit(1).fixedSize()
            }
            if let glyph = line.glyph {
                Image(systemName: Self.symbol(glyph))
                    .font(.orbitMeta)
                    .foregroundStyle(line.isWarning ? Color.orange : Color.secondary)
                    .fixedSize()
            }
            if let mark = line.anchorMark {
                // A wiki entry's anchor, checked: `✓ 4db4f9f`, or the warning word in its own tone.
                HStack(spacing: 2) {
                    if mark.tone == .green { Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)) }
                    Text(mark.word).font(.orbitMeta.weight(.semibold))
                }
                .foregroundStyle(WikiPalette.color(mark.tone))
                .fixedSize()
            }
            Text(line.text)
                .font(.orbitLabel)
                .foregroundStyle(line.isWarning ? Color.orange : Color.secondary)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
        }
    }

    /// Where the project is coordinated, and how long ago — under a rule, as the mock draws it.
    private func footRow(_ foot: OrbitLinkCardContent.Foot) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "bubble.left").font(.orbitMeta).foregroundStyle(.secondary)
            Text(foot.text).font(.orbitLabel).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 6)
            if let time = foot.time {
                Text(time).font(.orbitLabel).foregroundStyle(.secondary).fixedSize()
            }
            Image(systemName: "chevron.right").font(.orbitMeta).foregroundStyle(.secondary).fixedSize()
        }
        .padding(.top, 7)
        // Wrapped in a stack so the rule draws horizontally: a bare `Divider()` in an overlay has no
        // stack axis and renders as a vertical line down the middle.
        .overlay(alignment: .top) { VStack(spacing: 0) { Divider() } }
    }

    /// A skeleton bar, while the first read is out.
    private func bar(_ fraction: CGFloat) -> some View {
        GeometryReader { geometry in
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.primary.opacity(0.07))
                .frame(width: geometry.size.width * fraction)
        }
        .frame(height: 12)
    }

    /// The mono hint under a card with no object to describe: the deployment's own path for it.
    private func path(_ path: String) -> some View {
        Text(path)
            .font(.orbitMonoFine)
            .foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.middle)
    }

    // MARK: actions

    /// A tap goes where the object lives — and, for a link the server would not describe, out to the
    /// deployment's own page. Both rules are OrbitKit's (`OrbitLinkDestination.tap`).
    private func open() {
        // Nothing to route through means nothing drew the card in the first place; a tap there has
        // nowhere to go and no store to ask.
        guard let app, let cards else { return }
        app.open(cards.destination(for: ref), overConsole: overConsole)
    }

    @ViewBuilder private var menu: some View {
        if let url = cards?.pageURL(for: ref) {
            Button("Open in Safari") { app?.openExternal(url) }
            Button("Copy link") { PlatformPasteboard.copyString(url.absoluteString) }
        }
    }

    private static func symbol(_ kind: OrbitLinkKind) -> String {
        switch kind {
        case .project: return "square.stack.3d.up"
        case .task:    return "checkmark.square"
        case .session: return "bubble.left"
        case .list:    return "list.bullet"
        // The Wiki's own glyph — the drawer row's — so the tile says "wiki" whatever the entry's kind.
        case .wiki:    return AppSection.wiki.systemImage
        }
    }

    private static func symbol(_ glyph: OrbitLinkCardContent.Line.Glyph) -> String {
        switch glyph {
        case .project: return "square.stack.3d.up"
        case .warning: return "exclamationmark.triangle.fill"
        }
    }
}

/// A session's status, as the card's right-hand capsule: the shape `SessionStatusGlyph` draws
/// everywhere else in the app, in its own tone, with the words it already says.
private struct OrbitLinkStatusPill: View {
    let glyph: SessionStatusGlyph

    var body: some View {
        HStack(spacing: 4) {
            switch glyph.shape {
            case .spinner:
                ProgressView().controlSize(.mini)
            case .symbol(let name):
                Image(systemName: name).font(.orbitMeta)
            }
            Text(glyph.label).font(.orbitMeta).lineLimit(1).fixedSize()
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color)
    }

    /// The same tone mapping the session rows use (`StatusGlyphView`).
    private var color: Color {
        switch glyph.tone {
        case .brand:   return .blue
        case .success: return .green
        case .warning: return .orange
        case .error:   return .red
        case .neutral: return .secondary
        }
    }
}

/// A project's or a task list's progress, as the Tasks page draws it: done green, ready orange,
/// failed red, over the whole. A lane nobody is in draws no segment at all.
private struct OrbitLinkMeter: View {
    let segments: [OrbitLinkCardContent.Segment]

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                ForEach(segments.indices, id: \.self) { index in
                    color(segments[index].role)
                        .frame(width: geometry.size.width * segments[index].fraction)
                }
            }
        }
        .frame(height: 5)
        .background(Color.primary.opacity(0.08), in: Capsule())
        .clipShape(Capsule())
        .padding(.top, 1)
    }

    private func color(_ role: OrbitLinkCardContent.Segment.Role) -> Color {
        switch role {
        case .done:   return .green
        case .ready:  return .orange
        case .failed: return .red
        }
    }
}
