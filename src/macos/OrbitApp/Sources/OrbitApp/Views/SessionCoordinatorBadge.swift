import SwiftUI
import OrbitKit

/// Read-only Project relation metadata. It is intentionally not a SessionTag: users cannot edit
/// or filter it, and removing the Project pointer removes it authoritatively on the next summary.
struct SessionCoordinatorBadge: View {
    let session: Session

    @ViewBuilder var body: some View {
        if session.projectId != nil {
            Text("Coordinator")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(.secondary.opacity(0.14), in: Capsule())
                .fixedSize(horizontal: true, vertical: false)
                .help(session.projectTitle.map { "Coordinates \($0)" }
                    ?? "Coordinates a project")
                .accessibilityLabel("Project coordinator")
        }
    }
}
