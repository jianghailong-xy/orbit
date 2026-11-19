import SwiftUI
import OrbitKit

// The folds the transcript draws over the turns Orbit opened (`OrbitExchangeFold`; web parity:
// `components/OrbitExchangeFold.tsx`; design: docs/mocks/coordinator-exchange-fold/):
//
//   → Evidence revision 2 submitted: B1 — 我确认了 B1… · 5:14 PM            one exchange
//   ⋯ 7 Orbit updates handled · 3 evidence, 2 watches · 5:14 PM – 6:44 PM   two or more in a row
//       › B1 Targeted hints · 6 updates · 3 downstream · last: … · 6:44 PM   opened: by task, roots shut
//
// Opening an exchange draws the rows the conversation drew before the fold existed, through the
// console's own row view (`render`). A record link or a search hit that lands inside opens the way
// down to it (`reveal`). Shared by macOS and iOS; SwiftUI here is parse-checked only on Linux.

/// How a fold says when: the device's short time, as the turn foot says it.
private func exchangeClock(_ ts: String?) -> String {
    guard let ts, let date = ThinkingSummary.date(ts) else { return "" }
    return date.formatted(date: .omitted, time: .shortened)
}

struct OrbitExchangeFoldView: View {
    let exchanges: [OrbitExchange]
    /// The item a record link or a search hit asked for; the fold holding it opens the way to it.
    let reveal: String?
    let lookup: ExchangeTreeLookup
    /// Asked once a group opens: the project's dependency graph is read only then.
    let want: () -> Void
    let render: (TranscriptRow) -> AnyView

    var body: some View {
        if exchanges.count == 1, let only = exchanges.first {
            ExchangeRowView(exchange: only, inTask: false, reveal: reveal, render: render)
        } else {
            ExchangeGroupView(exchanges: exchanges, reveal: reveal, lookup: lookup, want: want, render: render)
        }
    }
}

/// The muted line every fold opens from: a mark, what it is, what it says, when — and a chevron.
private struct FoldLine: View {
    let mark: String?
    let chevronFirst: Bool
    let title: String
    let titleStrong: Bool
    let detail: String
    let detailPrefix: String
    let time: String
    let expanded: Bool
    let toggle: () -> Void

    var body: some View {
        Group {
            #if os(iOS)
            // A phone has no room for both halves on one row: what happened and when, then the rest.
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    lead
                    titleText.lineLimit(1)
                    Spacer(minLength: 4)
                    Text(time).font(.orbitMeta).foregroundStyle(.secondary).monospacedDigit()
                }
                if !detail.isEmpty {
                    Text(detail).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
                        .padding(.leading, 18)
                }
            }
            #else
            HStack(spacing: 6) {
                lead
                titleText.lineLimit(1).layoutPriority(1)
                if !detail.isEmpty {
                    Text("\(detailPrefix)\(detail)").font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(time).font(.orbitMeta).foregroundStyle(.secondary).monospacedDigit()
                if !chevronFirst { chevron }
            }
            #endif
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: toggle)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }

    @ViewBuilder private var lead: some View {
        if chevronFirst { chevron }
        if let mark { Text(mark).font(.orbitMeta).foregroundStyle(.tertiary).frame(width: 12) }
    }

    private var titleText: some View {
        Text(title).font(.orbitLabel).fontWeight(titleStrong ? .medium : .regular)
            .foregroundStyle(titleStrong ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
    }

    // Turned, not swapped — see ToolCardView: the two chevron symbols are different sizes.
    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12)
    }
}

/// What lies under an open fold: indented behind the rule a steps line draws.
private struct FoldBody<Content: View>: View {
    var dashed = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) { content }
            .padding(.leading, 12)
            .overlay(alignment: .leading) {
                Rectangle().fill(Color.primary.opacity(dashed ? 0.10 : 0.14)).frame(width: dashed ? 1 : 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ExchangeRowView: View {
    let exchange: OrbitExchange
    let inTask: Bool
    let reveal: String?
    let render: (TranscriptRow) -> AnyView
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FoldLine(mark: "→", chevronFirst: false,
                     title: inTask ? (exchange.whatInTask ?? exchange.what) : exchange.what,
                     titleStrong: false, detail: exchange.reply, detailPrefix: "— ",
                     time: exchangeClock(exchange.ts), expanded: expanded) { expanded.toggle() }
            if expanded {
                FoldBody {
                    ForEach(exchange.rows) { row in render(row) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Instantly, for `StepsRowView`'s reason: a List cell re-measured while its content animates flickers.
        .animation(nil, value: expanded)
        .onAppear(perform: openIfRevealed)
        .onChange(of: reveal) { _, _ in openIfRevealed() }
    }

    private func openIfRevealed() {
        if let reveal, exchange.itemIDs.contains(reveal) { expanded = true }
    }
}

private struct ExchangeGroupView: View {
    let exchanges: [OrbitExchange]
    let reveal: String?
    let lookup: ExchangeTreeLookup
    let want: () -> Void
    let render: (TranscriptRow) -> AnyView
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FoldLine(mark: "⋯", chevronFirst: false,
                     title: OrbitExchangeFold.groupCount(exchanges.count), titleStrong: false,
                     detail: OrbitExchangeFold.kinds(exchanges), detailPrefix: "· ",
                     time: "\(exchangeClock(exchanges.first?.ts)) – \(exchangeClock(exchanges.last?.ts))",
                     expanded: expanded) { expanded.toggle() }
            if expanded {
                FoldBody {
                    if let tree = OrbitExchangeFold.tree(exchanges, lookup: lookup) {
                        ForEach(tree) { branch in
                            TaskBranchView(branch: branch, reveal: reveal, render: render)
                        }
                    } else {
                        ForEach(exchanges) { exchange in
                            ExchangeRowView(exchange: exchange, inTask: false, reveal: reveal, render: render)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(nil, value: expanded)
        .onAppear(perform: openIfRevealed)
        .onChange(of: reveal) { _, _ in openIfRevealed() }
        .onChange(of: expanded) { _, open in if open { want() } }
    }

    private func openIfRevealed() {
        if let reveal, exchanges.contains(where: { $0.itemIDs.contains(reveal) }) { expanded = true }
    }
}

/// A task in a group's tree: shut, it sums up everything beneath it; open, its own exchanges, then
/// the tasks after it.
private struct TaskBranchView: View {
    let branch: ExchangeBranch
    let reveal: String?
    let render: (TranscriptRow) -> AnyView
    @State private var expanded = false

    var body: some View {
        let every = OrbitExchangeFold.branchExchanges(branch)
        let latest = expanded ? branch.exchanges.last : every.last
        VStack(alignment: .leading, spacing: 4) {
            FoldLine(mark: nil, chevronFirst: true, title: branch.title, titleStrong: true,
                     detail: expanded ? phoneless(OrbitExchangeFold.updates(branch.exchanges.count))
                                      : OrbitExchangeFold.branchSummary(branch),
                     detailPrefix: "· ", time: exchangeClock(latest?.ts), expanded: expanded) { expanded.toggle() }
            if expanded {
                FoldBody(dashed: true) {
                    ForEach(branch.exchanges) { exchange in
                        ExchangeRowView(exchange: exchange, inTask: !branch.isOther, reveal: reveal, render: render)
                    }
                    ForEach(branch.children) { child in
                        TaskBranchView(branch: child, reveal: reveal, render: render)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(nil, value: expanded)
        .onAppear { openIfRevealed(every) }
        .onChange(of: reveal) { _, _ in openIfRevealed(every) }
    }

    /// An open branch's count is the rows under it on a phone: web hides it there too.
    private func phoneless(_ text: String) -> String {
        #if os(iOS)
        return ""
        #else
        return text
        #endif
    }

    private func openIfRevealed(_ every: [OrbitExchange]) {
        if let reveal, every.contains(where: { $0.itemIDs.contains(reveal) }) { expanded = true }
    }
}
