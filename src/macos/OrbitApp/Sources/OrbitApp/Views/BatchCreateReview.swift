import SwiftUI
import OrbitKit

// The batch-create card's review. It shows what the write does, where the tasks land and what shape
// they make, then the tasks: one numbered list, or by level when they wait on each other. Each task
// is one push from a page of its own. Approved as docs/mocks/batch-create-review-ios (index.html
// ②③④ and dependencies.html). The rules are OrbitKit's (BatchReview.swift, tested on Linux); this
// file only draws them.

extension Color {
    /// The grouped review's backdrop and its cards: iOS's own grouped pair, and on the Mac the window
    /// and the control surface, the pair a grouped `Form` draws there.
    static var reviewBackdrop: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }

    static var reviewCard: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}

/// A card of rows on the grouped backdrop. The radius is the inset-grouped one iOS 26 draws (and
/// `ProviderPoolViews` with it); the Mac gets a Mac-sized one.
struct ReviewCardGroup<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) { self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.reviewCard, in: RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
    }

    #if os(iOS)
    private static var radius: CGFloat { 26 }
    #else
    private static var radius: CGFloat { 10 }
    #endif
}

/// One consequence of the write: a mark for its kind, the count and what happens to it, and the
/// reason under it. The words are `batchImpactRows`' own, split at the sentence's dash.
struct BatchImpactRowView: View {
    let row: BatchImpactRow

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(tone)
                .frame(width: 30, height: 30)
                .background(tone.opacity(0.15), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(row.head)
                    .font(.orbitProse.weight(.semibold))
                    .foregroundStyle(.primary)
                if let reason = row.reason {
                    Text(reason)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch row.kind {
        case .starting: return "play.fill"
        case .waiting: return "hourglass"
        case .manualStart: return "pause.circle"
        case .cannotRun: return "exclamationmark.triangle.fill"
        }
    }

    /// Web's tones for the same lines: running is green, cannot-run is amber, the rest stay quiet.
    private var tone: Color {
        switch row.kind {
        case .starting: return .green
        case .cannotRun: return .orange
        case .waiting, .manualStart: return .secondary
        }
    }
}

/// The review's content for a batch. It has no header: the navigation bar already asks the
/// question, and the transcript's preview draws its own.
struct BatchCreateReviewBody: View {
    let batch: BatchApprovalPreview
    /// The bodies the runner will send, for the task pages.
    let details: [BatchTaskDetail]
    /// Closes the review from a pushed page, whose toolbar is its own.
    let close: () -> Void

    var body: some View {
        let levels = Approvals.batchLevels(batch.tasks)
        let impact = Approvals.batchImpactRows(batch)
        let detail = Approvals.batchDetailLine(batch)
        VStack(alignment: .leading, spacing: 22) {
            if !impact.isEmpty {
                ReviewCardGroup {
                    ForEach(Array(impact.enumerated()), id: \.element.id) { n, row in
                        if n > 0 { Divider().padding(.leading, 58) }
                        BatchImpactRowView(row: row)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 7) {
                if !detail.isEmpty {
                    Text(detail)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                }
                if levels.count > 1 {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(levels) { level in
                            BatchLevelBlock(level: level, isFirst: level.number == 1,
                                            isLast: level.number == levels.count) { row in
                                link(row, levels: levels)
                            }
                        }
                    }
                } else if let only = levels.first {
                    ReviewCardGroup {
                        ForEach(Array(only.rows.enumerated()), id: \.element.id) { n, row in
                            if n > 0 { Divider().padding(.leading, 50) }
                            link(row, levels: levels)
                        }
                    }
                }
                if batch.titlesTruncated > 0 {
                    Text(Approvals.batchMore(batch.titlesTruncated))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func link(_ row: BatchLevelRow, levels: [BatchLevel]) -> some View {
        NavigationLink {
            BatchTaskPage(row: row, levels: levels, details: details,
                          total: batch.titlesTruncated > 0 ? nil : batch.tasks.count, close: close)
        } label: {
            BatchTaskRowLabel(row: row)
        }
        .buttonStyle(.plain)
    }
}

/// One level: its name, how many run in parallel when more than one does, and its rows. A rail runs
/// from level to level so the order reads top to bottom.
private struct BatchLevelBlock<Row: View>: View {
    let level: BatchLevel
    let isFirst: Bool
    let isLast: Bool
    @ViewBuilder let row: (BatchLevelRow) -> Row

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            heading
            ReviewCardGroup {
                ForEach(Array(level.rows.enumerated()), id: \.element.id) { n, r in
                    if n > 0 { Divider().padding(.leading, 50) }
                    row(r)
                }
            }
        }
        .padding(.leading, 22)
        .padding(.bottom, isLast ? 0 : 10)
        .background(alignment: .topLeading) { rail }
    }

    private var heading: some View {
        let parallel = Approvals.batchLevelParallel(level).map { Text(verbatim: " · \($0)") } ?? Text(verbatim: "")
        return (Text(Approvals.batchLevelName(level)).fontWeight(.semibold) + parallel)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(.leading, 2)
    }

    /// The dot sits on the heading's line. The segment above it joins the level before, and the one
    /// below runs to the next.
    private var rail: some View {
        VStack(spacing: 0) {
            Rectangle().fill(isFirst ? Color.clear : Self.railTone).frame(width: 1.5, height: 4)
            Circle().fill(Self.dotTone).frame(width: 10, height: 10)
            Rectangle().fill(isLast ? Color.clear : Self.railTone).frame(width: 1.5)
                .frame(maxHeight: .infinity)
        }
        .frame(width: 14)
    }

    private static var railTone: Color { Color.secondary.opacity(0.35) }
    private static var dotTone: Color { Color.secondary.opacity(0.5) }
}

/// A task's number in a filled circle: on its own row, and small inside another row's "Waits on".
struct BatchNumberBadge: View {
    let number: Int
    var small = false

    var body: some View {
        Text(verbatim: "\(number)")
            .font((small ? Font.orbitMeta : Font.orbitLabel).weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .frame(width: small ? 18 : 24, height: small ? 18 : 24)
            .background(Color.secondary.opacity(0.12), in: Circle())
    }
}

/// A task's row: its number, its title, what it waits on, and the chevron that says it opens.
struct BatchTaskRowLabel: View {
    let row: BatchLevelRow
    /// A page's own "Waits on" and "Needed by" rows leave the note off, since the section heading
    /// already says it.
    var showsWaits = true

    var body: some View {
        HStack(spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                BatchNumberBadge(number: row.number)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.orbitProse)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if showsWaits { waitsNote }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var waitsNote: some View {
        if !row.waitsOn.isEmpty || row.waitsOutside {
            HStack(spacing: 4) {
                Text(Approvals.batchWaitsOn)
                ForEach(row.waitsOn, id: \.self) { BatchNumberBadge(number: $0, small: true) }
                if row.waitsOutside {
                    Text(row.waitsOn.isEmpty ? Approvals.batchOutsideTask : Approvals.batchAndOutsideTask)
                }
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
        }
    }
}

/// One task of the batch, pushed from its row. It shows what the task waits on and what waits on
/// it, how it is judged, and the body the runner will send. There is no Create here: pressing it on
/// one task's page would read as creating that task alone, and the decision is the whole batch's.
struct BatchTaskPage: View {
    let row: BatchLevelRow
    let levels: [BatchLevel]
    let details: [BatchTaskDetail]
    /// The batch's size when the card holds all of it. Nil for a window, which has no total to name.
    let total: Int?
    let close: () -> Void

    var body: some View {
        let detail = Approvals.batchTaskDetail(for: row, in: details)
        let waitsOn = levels.flatMap(\.rows).filter { row.waitsOn.contains($0.number) }
        let neededBy = Approvals.batchNeededBy(row, in: levels)
        let chips = [detail?.judgedBy].compactMap { $0 } + (detail?.labels ?? [])
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title)
                    .font(.orbitHeading(2))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                if !chips.isEmpty {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) { ForEach(chips, id: \.self) { chip($0) } }
                        VStack(alignment: .leading, spacing: 6) { ForEach(chips, id: \.self) { chip($0) } }
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 10)
                }
                if !waitsOn.isEmpty || row.waitsOutside {
                    section(Approvals.batchWaitsOn) {
                        ReviewCardGroup {
                            ForEach(Array(waitsOn.enumerated()), id: \.element.id) { n, r in
                                if n > 0 { Divider().padding(.leading, 50) }
                                link(r)
                            }
                            if row.waitsOutside {
                                if !waitsOn.isEmpty { Divider().padding(.leading, 16) }
                                Text(Approvals.batchOutsideTask.prefix(1).uppercased()
                                     + Approvals.batchOutsideTask.dropFirst())
                                    .font(.orbitProse)
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 11)
                            }
                        }
                    }
                }
                if !neededBy.isEmpty {
                    section(Approvals.batchNeededByHeading) {
                        ReviewCardGroup {
                            ForEach(Array(neededBy.enumerated()), id: \.element.id) { n, r in
                                if n > 0 { Divider().padding(.leading, 50) }
                                link(r)
                            }
                        }
                    }
                }
                if let criteria = detail?.acceptanceCriteria, !criteria.isEmpty {
                    section(Approvals.createDoneWhen) { prose(criteria) }
                }
                if let description = detail?.description, !description.isEmpty {
                    section(Approvals.batchDescriptionHeading) { prose(description) }
                }
            }
            .padding()
        }
        .background(Color.reviewBackdrop)
        .navigationTitle(Approvals.batchTaskPageTitle(row.number, of: total))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { ApprovalReviewCloseButton(close: close) }
    }

    @ViewBuilder
    private func section<Content: View>(_ heading: String, @ViewBuilder content: () -> Content) -> some View {
        Text(heading)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 22)
            .padding(.bottom, 7)
        content()
    }

    /// The task's own Markdown, as the single create card draws its description.
    private func prose(_ source: String) -> some View {
        ReviewCardGroup {
            MarkdownView(source: source)
                .font(.orbitProse)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        }
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Color.secondary.opacity(0.12), in: Capsule())
    }

    /// Another task of the same batch, one push further. Its page has the same ✕.
    private func link(_ other: BatchLevelRow) -> some View {
        NavigationLink {
            BatchTaskPage(row: other, levels: levels, details: details, total: total, close: close)
        } label: {
            BatchTaskRowLabel(row: other, showsWaits: false)
        }
        .buttonStyle(.plain)
    }
}
