import SwiftUI
import OrbitKit

/// Top bar: worktree change summary + Commit / Merge. Disabled mid-turn (a running turn may be
/// editing files). Tapping the file count opens the per-file diff sheet.
struct WorktreeBar: View {
    let console: ConsoleModel
    @State private var showDiff = false

    private var busy: Bool { console.state.status == .running || console.worktreeBusy }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
            if console.diff.isEmpty {
                Text("No worktree changes").foregroundStyle(.secondary)
            } else {
                Button { showDiff = true } label: {
                    Text("\(console.diff.count) changed file\(console.diff.count == 1 ? "" : "s")")
                }
                .buttonStyle(.link)
            }
            Spacer()
            Button("Commit") { Task { await console.commit() } }.disabled(busy)
            Button("Merge") { Task { await console.merge(target: nil) } }.disabled(busy)
        }
        .font(.caption)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
        .task { await console.loadDiff() }
        .sheet(isPresented: $showDiff) { DiffSheet(patches: console.diff) }
    }
}

struct DiffSheet: View {
    let patches: [FilePatch]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(patches) { patch in
                DisclosureGroup(patch.path) {
                    Text(patch.patch ?? "(no preview available)")
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if patch.truncated == true {
                        Text("(truncated)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Worktree changes")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }
}

/// Strip of background shells the agent launched, between the transcript and approvals.
struct BackgroundTrayView: View {
    let procs: [BackgroundProc]

    var body: some View {
        if !procs.isEmpty {
            HStack(spacing: 12) {
                Image(systemName: "gearshape.2.fill").foregroundStyle(.secondary)
                ForEach(procs) { proc in
                    HStack(spacing: 4) {
                        Circle().fill(color(proc.status)).frame(width: 6, height: 6)
                        Text(proc.command ?? proc.id).font(.caption.monospaced()).lineLimit(1)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(.bar)
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "completed": return .green
        case "failed", "killed": return .red
        default: return .orange
        }
    }
}
