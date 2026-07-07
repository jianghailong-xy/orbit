import SwiftUI
import OrbitKit

/// One pending approval, dispatched to the right card by kind (tool permission / AskUserQuestion
/// form / ExitPlanMode). Rendered inline in the transcript as the agent's latest turn — mirroring
/// web, whose AgentView places the ApprovalPanel right after the messages. So the card scrolls with
/// the conversation and a long AskUserQuestion form wraps in full (the transcript's own scroll gives
/// it unbounded height) instead of being crushed into the fixed, non-scrolling panel that used to sit
/// above the composer and truncated every line.
struct ApprovalCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    var body: some View {
        switch approval.kind {
        case .question: QuestionCard(console: console, approval: approval)
        case .plan:     PlanCard(console: console, approval: approval)
        case .tool:     ToolApprovalCard(console: console, approval: approval)
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
                .foregroundStyle(.orange).font(.orbitProse.bold())
            if let summary {
                Text(summary).font(.orbitMono).foregroundStyle(.secondary).lineLimit(3)
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
    @State private var custom: [String: String] = [:]

    private var questions: [AskQuestion] {
        approval.input.map { Approvals.parseQuestions(from: $0) } ?? []
    }
    private var allAnswered: Bool {
        Approvals.allAnswered(questions, selections: selections, custom: custom)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = q.header {
                        Text(header).font(.orbitLabel.bold()).foregroundStyle(.secondary)
                    }
                    Text(q.question).font(.orbitProse.bold())
                    ForEach(q.options) { opt in
                        Button { toggle(q, opt.label) } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: isSelected(q, opt.label) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(isSelected(q, opt.label) ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(opt.label)
                                    if let d = opt.description {
                                        Text(d).font(.orbitLabel).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    // claude's AskUserQuestion always allows a free-typed answer, not just a listed option.
                    TextField("Or type your own answer…", text: customBinding(q))
                        .textFieldStyle(.roundedBorder).font(.orbitControl)
                    if q.multiSelect {
                        Text("multi-select").font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Button("Submit") { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!allAnswered)
                // Reply conversationally in the main composer instead of picking an option; the
                // text rides back as a deny+message (handled by ConsoleModel.send).
                Button {
                    console.startChatReply(approvalID: approval.id,
                                           question: Approvals.chatReplyLabel(questions))
                } label: {
                    Label("Chat about this", systemImage: "bubble.left.and.bubble.right")
                }
                .buttonStyle(.bordered)
                Spacer()
            }
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
            custom[q.question] = ""           // single-select: a listed option and free text are exclusive
        }
        selections[q.question] = set
    }
    /// Binding for a question's free-text field; for single-select, typing clears any picked option.
    private func customBinding(_ q: AskQuestion) -> Binding<String> {
        Binding(
            get: { custom[q.question] ?? "" },
            set: { value in
                custom[q.question] = value
                if !q.multiSelect, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    selections[q.question] = []
                }
            }
        )
    }
    private func submit() async {
        await console.decide(approval, behavior: .allow,
                             answers: Approvals.buildAnswers(questions, selections: selections, custom: custom))
    }
}

struct PlanCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var plan: String { approval.input?["plan"]?.stringValue ?? "Plan ready for review." }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Plan", systemImage: "list.bullet.clipboard").font(.orbitProse.bold())
            MarkdownView(source: plan).font(.orbitProse).textSelection(.enabled)
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
