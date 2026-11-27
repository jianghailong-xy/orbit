import SwiftUI
import OrbitKit

// An agent asking to reopen a settled project (docs/project-reopen-request-design.md §6): the PROJECT_REOPEN card in the
// conversation that asked, and the same card as a row above the project page's header. Every word is
// `ProjectReopenCopy` in OrbitKit.

/// A PROJECT_REOPEN request: pending, the whole card; answered, one line saying how.
struct ProjectReopenCardView: View {
    @Environment(AppModel.self) private var appModel
    let model: OwnerRequestsModel
    let request: OwnerRequest
    /// Hands a talk about the request to the conversation's composer. Nil on the project page, where Chat about this
    /// opens the decline form instead: the reason goes to the asking session.
    var onChat: ((OwnerRequest) -> Void)? = nil
    var onProjectPage = false

    @State private var declining = false
    @State private var reason = ""
    @State private var busy = false
    @State private var failure: String?

    private var facts: ProjectReopenFacts? { ProjectReopenFacts(request) }

    var body: some View {
        Group {
            if request.state == .declined {
                folded(symbol: "xmark.circle.fill", tint: .red)
            } else if request.state == .done {
                folded(symbol: "checkmark.circle.fill", tint: .green)
            } else {
                card
            }
        }
        .accessibilityIdentifier("owner-request-\(request.id)")
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            if onProjectPage {
                Text(ProjectReopenCopy.projectPageRow).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(request.title.hasPrefix("↺") ? request.title : "↺ \(request.title)").font(.headline)
            if let facts {
                Text(ProjectReopenCopy.settledLine(status: facts.statusAtAsk, settledAt: facts.settledAt))
                    .font(.orbitSubtext).foregroundStyle(.secondary)
            }
            if !request.why.isEmpty {
                labelled(ProjectReopenCopy.whyLabel, ProjectReopenCopy.agentSays(request.why))
            }
            if let plan = facts?.plannedWork, !plan.isEmpty {
                labelled(ProjectReopenCopy.plannedWorkLabel, plan)
            }
            if let asker = askerLine { Text(asker).font(.orbitLabel).foregroundStyle(.secondary) }
            if let failure {
                Label { Text("\(OwnerRequests.notRecorded): \(failure)") } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.orbitLabel).foregroundStyle(.red)
            }
            if declining { declineForm } else { actions }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.orange.opacity(0.45)))
    }

    private func labelled(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            Text(text).font(.orbitProse).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "Asked by <session>" outside that session, then "Also asked by …" for the others.
    private var askerLine: String? {
        let others = facts?.otherAskerTitles(besides: request.askedBySessionId) ?? []
        let parts = [onProjectPage ? ProjectReopenCopy.askedBy(request.askedBySessionTitle) : nil,
                     ProjectReopenCopy.alsoAskedBy(others)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var actions: some View {
        ApprovalActions {
            Button { reopen() } label: {
                Text(ProjectReopenCopy.reopen).bold().approvalActionLabel()
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(busy)
            .accessibilityIdentifier("project-reopen-reopen")
            Button {
                if let onChat { onChat(request) } else { declining = true }
            } label: {
                Text(ProjectReopenCopy.chat).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            .accessibilityIdentifier("project-reopen-chat")
        }
        .lineLimit(1)
    }

    private var declineForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(ProjectReopenCopy.declinePlaceholder, text: $reason, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 12) {
                Button(ProjectReopenCopy.decline) { decline() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(ProjectReopenCopy.keep) { declining = false }.buttonStyle(.borderless)
            }
        }
    }

    private func folded(symbol: String, tint: Color) -> some View {
        Label { Text(ProjectReopenCopy.outcomeLine(request)) } icon: { Image(systemName: symbol).foregroundStyle(tint) }
            .font(.orbitSubtext)
            .padding(.vertical, 8)
    }

    private func reopen() {
        busy = true
        failure = nil
        Task { @MainActor in
            do {
                try await model.reopenProject(request)
                if let id = facts?.projectId { await appModel.projects?.detail(id).load() }
            } catch {
                failure = error.localizedDescription
            }
            busy = false
        }
    }

    private func decline() {
        busy = true
        failure = nil
        let words = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { @MainActor in
            do { try await model.decline(request, reason: words) } catch { failure = error.localizedDescription }
            busy = false
        }
    }
}
