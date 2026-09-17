#if os(iOS)
import SwiftUI
import OrbitKit

/// Settings' middle column on a regular-width iPad: the form's own sections as rows.
///
/// Every other section fills both columns — a list and the thing it selects. Settings filled one
/// and left the detail pane on `ContentUnavailableView`, so the larger half of the screen read
/// "Browse settings in the list." while the whole form crowded into the narrower half. Listing the
/// categories here gives the pane the obvious thing to show.
struct SettingsCategoryList: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        return List {
            Section {
                ForEach(SettingsCategory.visible) { category in
                    // A Button rather than `List(selection:)`: this selection sits beside the
                    // section's stack instead of on it, because a category is column content and
                    // not a frame — so the row also draws its own current state.
                    Button {
                        model.settingsCategory = category
                    } label: {
                        Label(category.title, systemImage: category.systemImage)
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(category == model.settingsCategory
                                       ? Color.accentColor.opacity(0.18)
                                       : Color.clear)
                    .accessibilityAddTraits(category == model.settingsCategory
                                            ? [.isButton, .isSelected] : .isButton)
                }
            }

            // Runners stays a push, the same frame the form pushes on iPhone — it is a page, not a
            // category, and `sectionAtRoot` still reads this section's depth off that one stack.
            Section {
                NavigationLink(value: NavNode.settingsRunners) {
                    Label("Runners", systemImage: AppSection.runners.systemImage)
                }
            }
        }
        // Registered here for the same reason the form registers it: this is the column the push
        // lands in when the shell is the three-column one.
        .navigationDestination(for: NavNode.self) { node in
            switch node {
            case .settingsRunners:
                RunnersSettingsList()
            case .runnerDetail(let runnerID):
                RunnerDetailView(runnerID: runnerID)
            default:
                EmptyView()
            }
        }
        .orbitRevealSurface()
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Settings' detail column on a regular-width iPad: one category's controls, held to a readable
/// width.
///
/// A settings row stretched across ~900pt is harder to read, not easier — the label ends up an
/// eye-sweep away from the control it names. So the form keeps a column's worth of width and the
/// rest stays margin. That whitespace is a choice; the placeholder sentence it replaces was not.
struct SettingsDetail: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        SettingsView(category: model.settingsCategory)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
#endif
