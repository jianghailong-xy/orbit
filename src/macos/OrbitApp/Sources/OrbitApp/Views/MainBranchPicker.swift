import SwiftUI
import OrbitKit

/// Which branch is the project's main branch — where its tasks start from and its finished work
/// ends up (docs/mocks/project-main-branch/02-ios.png ③⑤⑦). It lists the branches the runner
/// reported for the coordination workspace's checkout — the list the session's Merge into offers —
/// and takes a typed name when the one wanted is not there, or no runner reported any. The branch
/// the owner chose last for the repository is tagged `last chosen`, and the current one is ticked.
///
/// One picker for the start card and How it runs, so the two cannot offer different branches: web's
/// `MainBranchSelect`, with its rows from `RunSettings.branchChoices`. Shaped like the session's
/// Merge into picker (`MergeTargetPickerSheet`): a half-height sheet on iPhone and a small window on
/// the Mac, its search field doubling as where a name is typed. A pick closes it.
struct MainBranchPicker: View {
    let current: String
    let branches: ProjectBranchCandidates?
    /// The branch the owner last chose for this repository, which the list tags.
    let remembered: String?
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(RunSettings.branchChoices(branches: branches, remembered: remembered,
                                                      current: current, query: query)) { choice in
                        row(choice)
                    }
                } header: {
                    Text(RunSettings.branchesHead(branches))
                } footer: {
                    Text(RunSettings.mainBranchHint)
                }
            }
            .listStyle(.plain)
            #if os(iOS)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: RunSettings.typeABranch)
            .textInputAutocapitalization(.never)
            .navigationBarTitleDisplayMode(.inline)
            #else
            .searchable(text: $query, prompt: RunSettings.typeABranch)
            #endif
            .autocorrectionDisabled()
            .navigationTitle(RunSettings.mainBranch)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 360, minHeight: 420)
        #endif
    }

    /// A branch by its name, in the mono the branch row shows it in, with `last chosen` after the
    /// remembered one and a tick on the current one; a typed name the runner never reported is
    /// offered as itself, in words.
    private func row(_ choice: RunSettings.BranchChoice) -> some View {
        Button {
            PlatformHaptics.tap()
            dismiss()
            onPick(choice.name)
        } label: {
            HStack(spacing: 8) {
                if choice.typed {
                    Text(choice.label).font(.orbitProse)
                } else {
                    Text(choice.name)
                        .font(.orbitProse.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if choice.lastChosen {
                        Text(RunSettings.lastChosen).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if choice.current {
                    Image(systemName: "checkmark")
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(choice.current ? .isSelected : [])
    }
}
