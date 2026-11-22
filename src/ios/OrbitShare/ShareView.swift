import SwiftUI
import OrbitKit

/// "Add to Orbit" (board docs/mocks/share-to-orbit/board-1.png, panels 2 and 3): Cancel / Add, the
/// shared items as chips, search, New session in the default workspace, Recent sessions from the
/// app's snapshot, an optional note; then the done state. SwiftUI only: the macOS Share-menu
/// extension hosts it too, laid out as board-3 panel 9 (title on top, Cancel / Add at the bottom).
struct ShareView: View {
    @Bindable var model: ShareModel
    var onCancel: () -> Void
    var onDone: () -> Void

    var body: some View {
        #if os(macOS)
        macBody
        #else
        phoneBody
        #endif
    }

    #if os(macOS)
    /// A Share-menu popover has no navigation bar. Add opens Orbit on the entry, so a hand-off that
    /// reached the app closes the popover at once; only one that did not shows the done state.
    private var macBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isDone {
                Text(ShareCopy.title).font(.headline).padding([.horizontal, .top], 16).padding(.bottom, 4)
            }
            content
            if !isDone {
                Divider()
                HStack {
                    Spacer()
                    Button(ShareCopy.cancel, action: onCancel).keyboardShortcut(.cancelAction)
                    if model.phase == .adding {
                        ProgressView().controlSize(.small).frame(width: 52)
                    } else {
                        Button(ShareCopy.add) { Task { await model.add() } }
                            .keyboardShortcut(.defaultAction)
                            .disabled(!model.canAdd)
                    }
                }
                .padding(12)
            }
        }
        .frame(width: 420, height: 480)
        .onChange(of: model.phase) { _, phase in
            if case .done(_, true) = phase { onDone() }
        }
    }
    #endif

    private var phoneBody: some View {
        NavigationStack {
            content
                .navigationTitle(ShareCopy.title)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    if !isDone {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(ShareCopy.cancel, action: onCancel)
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            if model.phase == .adding {
                                ProgressView()
                            } else {
                                Button(ShareCopy.add) { Task { await model.add() } }
                                    .fontWeight(.semibold)
                                    .disabled(!model.canAdd)
                            }
                        }
                    }
                }
        }
        .onChange(of: model.phase) { _, phase in
            if phase == .opened { onDone() }
        }
    }

    private var isDone: Bool {
        if case .done = model.phase { return true }
        return false
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading, .opened:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .done(let title, let notified):
            DoneView(title: title, notified: notified, onDone: onDone)
        default:
            if model.snapshot == nil {
                SignedOutView()
            } else {
                picker
            }
        }
    }

    private var picker: some View {
        List {
            Section {
                ChipsRow(items: model.items)
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                if case .failed(let message) = model.phase {
                    Text(message).font(.footnote).foregroundStyle(.red)
                } else if model.going.isEmpty {
                    Text(ShareCopy.nothingToAdd).font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(ShareCopy.searchPlaceholder, text: $model.query)
                        .autocorrectionDisabled()
                }
            }
            if let workspace = model.workspace {
                Section {
                    NewSessionRow(model: model, workspace: workspace)
                }
            }
            Section(ShareCopy.recent) {
                if model.rows.isEmpty {
                    Text(ShareCopy.noMatches).foregroundStyle(.secondary)
                }
                ForEach(model.rows, id: \.id) { row in
                    SessionRow(row: row, selected: model.destination == .session(row)) {
                        model.choose(.session(row))
                    }
                }
            }
            Section {
                TextField(ShareCopy.notePlaceholder, text: $model.note, axis: .vertical)
                    .lineLimit(1...3)
            }
        }
    }
}

/// The shared items as chips, wrapping onto as many lines as they need; one that will not go is
/// struck out with its reason.
private struct ChipsRow: View {
    let items: [SharePickerItem]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(items) { item in Chip(item: item) }
        }
    }
}

/// Lays its children out left to right, starting a new line when the next one does not fit.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.reduce(0) { $0 + $1.width } + spacing * CGFloat(max($0.count - 1, 0)) }.max() ?? 0
        let height = rows.map { $0.map(\.height).max() ?? 0 }.reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        var index = 0
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            let height = row.map(\.height).max() ?? 0
            for size in row {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
                index += 1
            }
            y += height + spacing
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [[CGSize]] {
        var rows: [[CGSize]] = [[]]
        var used: CGFloat = 0
        for view in subviews {
            var size = view.sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            if !rows[rows.count - 1].isEmpty, used + spacing + size.width > width {
                rows.append([])
                used = 0
            }
            used += (rows[rows.count - 1].isEmpty ? 0 : spacing) + size.width
            rows[rows.count - 1].append(size)
        }
        return rows
    }
}

private struct Chip: View {
    let item: SharePickerItem

    var body: some View {
        let reason = item.rejectReason
        HStack(spacing: 6) {
            Text(item.badge)
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 4).padding(.vertical, 2)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .strikethrough(reason != nil)
                    .foregroundStyle(reason == nil ? .primary : .secondary)
                if let reason {
                    Text(reason).font(.caption2).foregroundStyle(.red)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.3)))
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        if let size = item.sizeLabel { return "\(item.name) · \(size)" }
        return item.name
    }
}

private struct NewSessionRow: View {
    @Bindable var model: ShareModel
    let workspace: RecentSessionsSnapshot.Workspace

    var body: some View {
        let selected = model.destination == .newSession(workspace)
        HStack {
            Button { model.chooseWorkspace(workspace) } label: {
                // No "+": the row is a destination like the Recent rows below, not an action.
                HStack {
                    Text(ShareCopy.newSession).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            let workspaces = model.snapshot?.workspaces ?? []
            if workspaces.count > 1 {
                Menu {
                    ForEach(workspaces, id: \.id) { w in
                        Button(w.name) { model.chooseWorkspace(w) }
                    }
                } label: {
                    // Up-down chevrons: this opens a menu in place, it does not push a page.
                    Label(workspace.name, systemImage: "chevron.up.chevron.down")
                        .labelStyle(TrailingIconLabelStyle())
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                Text(workspace.name).font(.footnote).foregroundStyle(.secondary)
            }
            if selected {
                Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
            }
        }
    }
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 2) {
            configuration.title
            configuration.icon.imageScale(.small)
        }
    }
}

private struct SessionRow: View {
    let row: RecentSessionsSnapshot.Row
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).foregroundStyle(.primary).lineLimit(1)
                    Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var subtitle: String {
        let iso = ISO8601DateFormatter().string(from: row.updatedAt)
        return [row.workspaceName, RelativeTime.format(iso) ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct SignedOutView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.system(size: 44)).foregroundStyle(.secondary)
            Text(ShareCopy.signInFirst).font(.headline)
            Text(ShareCopy.signInDetail).font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct DoneView: View {
    let title: String
    let notified: Bool
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 60)).foregroundStyle(.green)
            Text(ShareCopy.added(to: title)).font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(notified ? ShareCopy.openToSend : ShareCopy.openToFinish)
                .font(.subheadline).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(ShareCopy.done, action: onDone)
                .buttonStyle(.borderedProminent)
                .padding(.top, 8)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
