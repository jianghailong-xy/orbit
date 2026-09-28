import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). The session list's options menu, as shipped and
// in three candidate shapes, picked by launch arguments: `-variant shipped|A|B|C -state default|full`.

enum Scope: String, CaseIterable, Identifiable {
    case open = "Open", completed = "Completed", trash = "Trash"
    var id: String { rawValue }
    /// The glyphs the session rows' own actions use for the same places (SessionRowActions).
    var icon: String {
        switch self {
        case .open: return "tray"
        case .completed: return "checkmark.circle"
        case .trash: return "trash"
        }
    }
}

let tagNames = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"]
let tagColors = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#AF52DE", "#8E8E93"]
/// The owner's seven system tags, as `/session-tags` returns them.
let realTags: [SessionTag] = tagNames.indices.map {
    SessionTag(id: "tag-\(tagNames[$0].lowercased())", name: tagNames[$0], color: tagColors[$0],
               isSystem: true, position: $0)
}

@main
struct ProbeApp: App {
    var body: some Scene { WindowGroup { ProbeRoot() } }
}

struct ProbeRoot: View {
    let variant: String
    @State private var view: Scope
    @State private var tagFilter: String?
    @State private var groupByTag: Bool
    @State private var query = ""

    init() {
        let args = ProcessInfo.processInfo.arguments
        func arg(_ key: String) -> String? {
            guard let i = args.firstIndex(of: key), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        variant = arg("-variant") ?? "A"
        let full = arg("-state") == "full"
        _view = State(initialValue: full ? .completed : .open)
        _tagFilter = State(initialValue: full ? "Blue" : nil)
        _groupByTag = State(initialValue: full)
    }

    var body: some View {
        NavigationStack {
            List {}
                .listStyle(.plain)
                .overlay {
                    ContentUnavailableView("No \(view.rawValue.lowercased()) sessions",
                                           systemImage: "bubble.left.and.bubble.right")
                }
                .navigationTitle("orbit")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                            prompt: "Search sessions")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {} label: { Image(systemName: "line.3.horizontal") }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if variant.hasPrefix("real") {
                            // The shipped function, cut out of AgentsView.swift (RealMenu.swift).
                            RealMenuProbe(app: StandInApp(sessionTags: realTags),
                                          includesScope: variant == "real",
                                          view: view == .completed ? .completed : (view == .trash ? .trash : .open),
                                          tagFilter: tagFilter.map { "tag-\($0.lowercased())" },
                                          groupByTag: groupByTag)
                        } else {
                        Menu { menuContent } label: {
                            Image(systemName: tagFilter == nil
                                  ? "line.3.horizontal.decrease"
                                  : "line.3.horizontal.decrease.circle.fill")
                        }
                        .accessibilityIdentifier("options")
                        }
                    }
                }
        }
    }

    @ViewBuilder private var menuContent: some View {
        switch variant {
        case "shipped": shipped
        case "B": candidate(scopeIcons: false, actionIcons: true)
        case "C": candidate(scopeIcons: true, actionIcons: true)
        case "E": oneColumn(palette: 0)
        case "D": oneColumn(palette: 1)
        case "D2": oneColumn(palette: 2)
        default: candidate(scopeIcons: false, actionIcons: false)
        }
    }

    /// AgentsView.sessionOptionsMenu as it is on main, minus the iPad branch.
    @ViewBuilder private var shipped: some View {
        ForEach(Scope.allCases) { v in
            Button { view = v } label: {
                if v == view { Label(v.rawValue, systemImage: "checkmark") }
                else { Text(v.rawValue) }
            }
        }
        Divider()
        Menu {
            Button { tagFilter = nil } label: {
                if tagFilter == nil { Label("All", systemImage: "checkmark") }
                else { Text("All") }
            }
            ForEach(tagNames, id: \.self) { tag in
                Button { tagFilter = (tagFilter == tag ? nil : tag) } label: {
                    if tagFilter == tag { Label(tag, systemImage: "checkmark") }
                    else { Text(tag) }
                }
            }
        } label: {
            Label("Filter by Tag", systemImage: "tag")
        }
        Button { groupByTag.toggle() } label: {
            if groupByTag { Label("Group by Tag", systemImage: "checkmark") }
            else { Text("Group by Tag") }
        }
        Divider()
        Button {} label: { Label("Settings", systemImage: "gearshape") }
    }

    /// A tick for the chosen option and the same glyph fully transparent for the others: every row
    /// keeps an image, so every title starts on the image column's edge (iOS 27 lays a row out on
    /// its own and only moves the title over when that row has an image).
    private func tick(_ on: Bool) -> Image {
        on ? Image(systemName: "checkmark")
           : Image(uiImage: UIImage(systemName: "checkmark")!.withTintColor(.clear, renderingMode: .alwaysOriginal))
    }

    /// E (palette 0): ticks and icons share one leading column — choice rows tick or stay blank,
    /// action rows (Filter by Tag, Settings) show their icon. D (1 = words, 2 = icons): the three
    /// scopes become a palette row at the top instead, the chosen one highlighted.
    @ViewBuilder private func oneColumn(palette: Int) -> some View {
        if palette == 0 {
            ForEach(Scope.allCases) { v in
                Button { view = v } label: { Label { Text(v.rawValue) } icon: { tick(v == view) } }
                    .accessibilityAddTraits(v == view ? .isSelected : [])
            }
        } else {
            Picker("Show", selection: $view) {
                if palette == 1 {
                    ForEach(Scope.allCases) { Text($0.rawValue).tag($0) }
                } else {
                    ForEach(Scope.allCases) { Label($0.rawValue, systemImage: $0.icon).tag($0) }
                }
            }
            .pickerStyle(.palette)
        }
        Divider()
        Menu {
            Toggle(isOn: Binding(get: { tagFilter == nil }, set: { if $0 { tagFilter = nil } })) {
                Text("All")
            }
            ForEach(tagNames, id: \.self) { tag in
                Toggle(isOn: Binding(get: { tagFilter == tag }, set: { tagFilter = $0 ? tag : nil })) {
                    Text(tag)
                }
            }
        } label: {
            Label("Filter by Tag", systemImage: "tag")
            if let t = tagFilter { Text(t) }
        }
        Button { groupByTag.toggle() } label: { Label { Text("Group by Tag") } icon: { tick(groupByTag) } }
            .accessibilityAddTraits(groupByTag ? .isSelected : [])
        Divider()
        Button {} label: { Label("Settings", systemImage: "gearshape") }
    }

    /// Every choice is a Toggle, so the system draws the tick in its own column (the Wiki space
    /// picker's shape). `scopeIcons` adds a glyph to Open / Completed / Trash and Group by Tag;
    /// `actionIcons` keeps the shipped `tag` and `gearshape`.
    @ViewBuilder private func candidate(scopeIcons: Bool, actionIcons: Bool) -> some View {
        ForEach(Scope.allCases) { v in
            Toggle(isOn: Binding(get: { view == v }, set: { if $0 { view = v } })) {
                if scopeIcons { Label(v.rawValue, systemImage: v.icon) } else { Text(v.rawValue) }
            }
        }
        Divider()
        Menu {
            Toggle(isOn: Binding(get: { tagFilter == nil }, set: { if $0 { tagFilter = nil } })) {
                Text("All")
            }
            ForEach(tagNames, id: \.self) { tag in
                Toggle(isOn: Binding(get: { tagFilter == tag }, set: { tagFilter = $0 ? tag : nil })) {
                    Text(tag)
                }
            }
        } label: {
            if actionIcons {
                Label {
                    Text("Filter by Tag")
                    if let t = tagFilter { Text(t) }
                } icon: {
                    Image(systemName: "tag")
                }
            } else {
                Text("Filter by Tag")
                if let t = tagFilter { Text(t) }
            }
        }
        Toggle(isOn: $groupByTag) {
            if scopeIcons { Label("Group by Tag", systemImage: "rectangle.3.group") }
            else { Text("Group by Tag") }
        }
        Divider()
        Button {} label: {
            if actionIcons { Label("Settings", systemImage: "gearshape") } else { Text("Settings") }
        }
    }
}
