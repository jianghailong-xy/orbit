import SwiftUI
import OrbitKit

/// Stack of pending approval cards shown above the composer. Dispatches each to the right card
/// by kind (tool permission / AskUserQuestion form / ExitPlanMode).
struct ApprovalsView: View {
    let console: ConsoleModel

    var body: some View {
        if !console.state.pendingApprovals.isEmpty {
            VStack(spacing: 8) {
                ForEach(console.state.pendingApprovals) { approval in
                    switch approval.kind {
                    case .question: QuestionCard(console: console, approval: approval)
                    case .plan:     PlanCard(console: console, approval: approval)
                    case .tool:     ToolApprovalCard(console: console, approval: approval)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
        }
    }
}

struct ToolApprovalCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var rememberRule: PermissionRule? {
        approval.input.flatMap { Approvals.rememberRule(toolName: approval.toolName ?? "", input: $0) }
    }
    private var summary: String? {
        approval.input?["command"]?.stringValue ?? approval.input?["file_path"]?.stringValue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(approval.toolName ?? "Tool", systemImage: "hand.raised.fill")
                .foregroundStyle(.orange).font(.callout.bold())
            if let summary {
                Text(summary).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack {
                Button("Allow") { Task { await console.decide(approval, behavior: .allow) } }
                    .buttonStyle(.borderedProminent)
                if let rule = rememberRule {
                    Button("Allow & remember \(Approvals.rememberLabel(rule))") {
                        Task { await console.decide(approval, behavior: .allow, remember: true) }
                    }
                }
                Button("Deny", role: .destructive) { Task { await console.decide(approval, behavior: .deny) } }
                Spacer()
            }
        }
        .padding(10)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct QuestionCard: View {
    let console: ConsoleModel
    let approval: PendingApproval
    @State private var selections: [String: Set<String>] = [:]

    private var questions: [AskQuestion] {
        approval.input.map { Approvals.parseQuestions(from: $0) } ?? []
    }
    private var allAnswered: Bool {
        questions.allSatisfy { !(selections[$0.question]?.isEmpty ?? true) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header {
                        Text(header).font(.caption.bold()).foregroundStyle(.secondary)
                    }
                    Text(q.question).font(.callout.bold())
                    ForEach(q.options) { opt in
                        Button { toggle(q, opt.label) } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: isSelected(q, opt.label) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(isSelected(q, opt.label) ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(opt.label)
                                    if let d = opt.description {
                                        Text(d).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    if q.multiSelect {
                        Text("multi-select").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Button("Submit") { Task { await submit() } }
                .buttonStyle(.borderedProminent)
                .disabled(!allAnswered)
        }
        .padding(10)
        .background(.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    private func isSelected(_ q: AskQuestion, _ label: String) -> Bool {
        selections[q.question]?.contains(label) ?? false
    }
    private func toggle(_ q: AskQuestion, _ label: String) {
        var set = selections[q.question] ?? []
        if q.multiSelect {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
        }
        selections[q.question] = set
    }
    private func submit() async {
        let answers = selections.mapValues { Array($0) }
        await console.decide(approval, behavior: .allow, answers: answers)
    }
}

struct PlanCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var plan: String { approval.input?["plan"]?.stringValue ?? "Plan ready for review." }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Plan", systemImage: "list.bullet.clipboard").font(.callout.bold())
            markdownText(plan).font(.callout).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Button("Approve") { Task { await console.decide(approval, behavior: .allow) } }
                    .buttonStyle(.borderedProminent)
                Button("Keep planning", role: .cancel) { Task { await console.decide(approval, behavior: .deny) } }
                Spacer()
            }
        }
        .padding(10)
        .background(.purple.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}
