import SwiftUI
import OrbitKit

// Session tags (Files.app-style colored labels). The library lives on `AppModel.sessionTags`
// (loaded from GET /session-tags — 7 system colors + custom tags); this file is the UI: the small
// row dots, the multi-select picker sheet, and the add/rename/recolor editor. Presented from a
// session row's "Tags…" action (see SessionRowActions) and filtered/grouped in AgentPanes.

extension Color {
    /// A Color from a `#RRGGBB` hex (the session-tag palette). Falls back to gray on a malformed
    /// value so a row never crashes on bad data.
    init(tagHex hex: String) {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard s.count == 6, let v = UInt32(s, radix: 16) else { self = .gray; return }
        self.init(red: Double((v >> 16) & 0xFF) / 255,
                  green: Double((v >> 8) & 0xFF) / 255,
                  blue: Double(v & 0xFF) / 255)
    }
}

/// The fixed swatches a custom tag picks its color from — the same 7 Apple system colors as the
/// seeded system tags, so custom and preset tags read as one palette (mirrors Files.app).
enum TagPalette {
    static let colors: [String] = [
        "#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#AF52DE", "#8E8E93",
    ]
}

/// The small colored dots on a session row marking its tags. Up to 3, then a "+N" overflow; renders
/// nothing when the session is untagged. Tags arrive server-ordered (system first).
struct SessionTagDots: View {
    let tags: [SessionTag]
    private var shown: [SessionTag] { Array(tags.prefix(3)) }
    private var overflow: Int { max(0, tags.count - shown.count) }

    var body: some View {
        if !tags.isEmpty {
            HStack(spacing: 3) {
                ForEach(shown) { t in
                    Circle().fill(Color(tagHex: t.color)).frame(width: 8, height: 8)
                }
                if overflow > 0 {
                    Text("+\(overflow)").font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            .accessibilityLabel("Tags: \(tags.map(\.name).joined(separator: ", "))")
        }
    }
}

/// Which tag the editor sheet is acting on: a brand-new tag, or an existing custom one being
/// renamed/recolored. `Identifiable` so it can drive `.sheet(item:)`.
enum TagEditTarget: Identifiable {
    case create
    case edit(SessionTag)
    var id: String {
        switch self {
        case .create: return "__create__"
        case .edit(let t): return t.id
        }
    }
}

/// The Files.app-style tag picker for one session: multi-select from the system colors + custom
/// tags (checkmark on the left, color dot on the right), plus add/rename/recolor/delete of custom
/// tags. Each toggle writes the full selection back immediately (the row's dots update on the next
/// list refresh).
struct SessionTagSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let session: Session
    @State private var selected: Set<String>
    @State private var editing: TagEditTarget?

    init(session: Session) {
        self.session = session
        _selected = State(initialValue: Set((session.tags ?? []).map(\.id)))
    }

    private var system: [SessionTag] { app.sessionTags.filter { $0.isSystem } }
    private var custom: [SessionTag] { app.sessionTags.filter { !$0.isSystem } }

    var body: some View {
        NavigationStack {
            List {
                Section("Colors") {
                    ForEach(system) { row($0) }
                }
                Section("My Tags") {
                    ForEach(custom) { t in
                        row(t).contextMenu {
                            Button { editing = .edit(t) } label: { Label("Rename / Color", systemImage: "pencil") }
                            Button(role: .destructive) {
                                app.deleteSessionTag(t.id)
                                selected.remove(t.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                    Button { editing = .create } label: {
                        Label("Add New Tag", systemImage: "plus.circle")
                    }
                }
            }
            .navigationTitle("Tags")
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                #else
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                #endif
            }
            .sheet(item: $editing) { TagEditor(target: $0).environment(app) }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }

    private func row(_ t: SessionTag) -> some View {
        Button {
            if selected.contains(t.id) { selected.remove(t.id) } else { selected.insert(t.id) }
            app.setSessionTags(session, tagIDs: Array(selected))
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selected.contains(t.id) ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected.contains(t.id) ? Color.accentColor : Color.secondary)
                Text(t.name).foregroundStyle(.primary)
                Spacer()
                Circle().fill(Color(tagHex: t.color)).frame(width: 22, height: 22)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Create a new custom tag or rename/recolor an existing one: a name field over the palette
/// swatches. Custom tags must pick a palette color (so every tag has a dot).
struct TagEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let target: TagEditTarget
    @State private var name: String
    @State private var color: String

    init(target: TagEditTarget) {
        self.target = target
        switch target {
        case .create:
            _name = State(initialValue: "")
            _color = State(initialValue: TagPalette.colors.first ?? "#8E8E93")
        case .edit(let t):
            _name = State(initialValue: t.name)
            _color = State(initialValue: t.color)
        }
    }

    private var isEdit: Bool { if case .edit = target { return true }; return false }
    private var canSave: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Tag name", text: $name)
                }
                Section("Color") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 12)], spacing: 12) {
                        ForEach(TagPalette.colors, id: \.self) { hex in
                            Circle().fill(Color(tagHex: hex)).frame(width: 32, height: 32)
                                .overlay {
                                    if hex == color { Circle().stroke(Color.primary, lineWidth: 2).padding(-3) }
                                }
                                .onTapGesture { color = hex }
                                .accessibilityLabel(hex == color ? "Selected color" : "Color")
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle(isEdit ? "Edit Tag" : "New Tag")
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button("Save", action: save).disabled(!canSave) }
                #else
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(!canSave) }
                #endif
            }
        }
        #if os(iOS)
        .presentationDetents([.medium])
        #endif
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespaces)
        switch target {
        case .create: app.createSessionTag(name: n, color: color)
        case .edit(let t): app.updateSessionTag(t.id, name: n, color: color)
        }
        dismiss()
    }
}
