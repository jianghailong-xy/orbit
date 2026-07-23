import Foundation

// Approval rendering + decision logic for the three card kinds:
//   • tool permission  → allow/deny (+ optional "remember same kind" rule)
//   • AskUserQuestion   → multiple-choice form; allow carries `answers`
//   • ExitPlanMode      → plan render; allow/deny
// Question/plan approvals are not repeatable, so they never get a remember rule. Ports the
// web's ApprovalPanel logic (bashPrefix / rememberRuleFor) so behavior matches exactly.

/// One AskUserQuestion question, parsed from the approval's `input.questions`.
public struct AskQuestion: Equatable, Sendable, Identifiable {
    public let header: String?
    public let question: String
    public let options: [AskOption]
    public let multiSelect: Bool
    public var id: String { question }
}

public struct AskOption: Equatable, Sendable, Identifiable {
    public let label: String
    public let description: String?
    public var id: String { label }
}

public enum Approvals {
    // MARK: AskUserQuestion

    public static func isQuestion(toolName: String) -> Bool { toolName == "AskUserQuestion" }
    public static func isPlan(toolName: String) -> Bool { toolName == "ExitPlanMode" }

    /// Classify an approval into the card it renders as. Keyed on `toolName` — the reliable
    /// signal the control plane always sends — because the question/plan data is nested under
    /// `input` (`input.questions` / `input.plan`), not a top-level field. Mirrors the web's
    /// `toolName === 'AskUserQuestion'` / `=== 'ExitPlanMode'` checks.
    public static func kind(toolName: String?) -> PendingApproval.Kind {
        let name = toolName ?? ""
        if isQuestion(toolName: name) { return .question }
        if isPlan(toolName: name) { return .plan }
        return .tool
    }

    /// True when a transcript tool card merely duplicates a still-pending question/plan approval:
    /// the live interactive `ApprovalCard` renders the same question/plan just below, so also drawing
    /// the read-only tool card double-shows it. Suppress the card until it resolves (its `result`
    /// lands), after which it's the historical record (question + chosen answer, or the plan). Mirrors
    /// web Transcript.tsx (`(AskUserQuestion|ExitPlanMode) && live && !result → return null`). Matched
    /// by kind: an AskUserQuestion/ExitPlanMode blocks the turn, so at most one question/plan approval
    /// is ever pending at a time.
    public static func duplicatesPendingApproval(_ item: TranscriptItem,
                                                 pendingApprovals: [PendingApproval]) -> Bool {
        guard case .toolCall(let card) = item, card.result == nil else { return false }
        let k = kind(toolName: card.name)
        guard k == .question || k == .plan else { return false }
        return pendingApprovals.contains { $0.kind == k }
    }

    /// Parse `input.questions` → structured questions for the form. Empty when not an
    /// AskUserQuestion (or malformed).
    public static func parseQuestions(from input: JSONValue) -> [AskQuestion] {
        guard case .array(let arr)? = input["questions"] else { return [] }
        return arr.map { q in
            var options: [AskOption] = []
            if case .array(let raw)? = q["options"] {
                options = raw.map { AskOption(label: $0["label"]?.stringValue ?? "",
                                              description: $0["description"]?.stringValue) }
            }
            return AskQuestion(header: q["header"]?.stringValue,
                               question: q["question"]?.stringValue ?? "",
                               options: options,
                               multiSelect: q["multiSelect"]?.boolValue ?? false)
        }
    }

    // MARK: AskUserQuestion answers (picked options + free text)

    /// A question is answered once it has a picked option OR non-empty typed text — claude's
    /// AskUserQuestion always lets the user write their own answer instead of picking a listed one.
    public static func isAnswered(question: String,
                                  selections: [String: Set<String>],
                                  custom: [String: String]) -> Bool {
        if !(selections[question]?.isEmpty ?? true) { return true }
        return !trimmed(custom[question]).isEmpty
    }

    /// All questions answered (and there is at least one) — gates Submit. Mirrors the web's
    /// `complete = questions.length > 0 && questions.every(answered)`.
    public static func allAnswered(_ questions: [AskQuestion],
                                   selections: [String: Set<String>],
                                   custom: [String: String]) -> Bool {
        !questions.isEmpty && questions.allSatisfy {
            isAnswered(question: $0.question, selections: selections, custom: custom)
        }
    }

    /// Build the `answers` payload (question text → labels): the picked option labels plus any
    /// trimmed free text the user typed (appended). Skips questions with neither. Mirrors the
    /// web QuestionForm submit (single-select keeps option/text mutually exclusive in the UI).
    public static func buildAnswers(_ questions: [AskQuestion],
                                    selections: [String: Set<String>],
                                    custom: [String: String]) -> [String: [String]] {
        var answers: [String: [String]] = [:]
        for q in questions {
            var picks = Array(selections[q.question] ?? [])
            let typed = trimmed(custom[q.question])
            if !typed.isEmpty { picks.append(typed) }
            if !q.question.isEmpty, !picks.isEmpty { answers[q.question] = picks }
        }
        return answers
    }

    /// The reply-chip label for "Chat about this": the first question's header, else its text.
    public static func chatReplyLabel(_ questions: [AskQuestion]) -> String {
        let first = questions.first
        let header = trimmed(first?.header)
        return header.isEmpty ? (first?.question ?? "") : header
    }

    private static func trimmed(_ s: String?) -> String {
        (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: remember-rule (allow + remember same kind)

    /// The session-scoped rule for "allow + remember", or nil when it doesn't apply:
    /// questions/plans aren't repeatable, and a Bash command with no clean prefix can't be
    /// generalized. Non-Bash tools get a tool-wide rule (no `ruleContent`).
    public static func rememberRule(toolName: String, input: JSONValue) -> PermissionRule? {
        if isQuestion(toolName: toolName) || isPlan(toolName: toolName) { return nil }
        if toolName == "Bash" {
            guard let cmd = input["command"]?.stringValue, let prefix = bashPrefix(cmd) else { return nil }
            return PermissionRule(toolName: "Bash", ruleContent: "\(prefix):*")
        }
        return PermissionRule(toolName: toolName)
    }

    /// Human-readable scope for the "remember" button ("git commit:*" → "git commit").
    public static func rememberLabel(_ rule: PermissionRule) -> String {
        if rule.toolName == "Bash", let rc = rule.ruleContent {
            return rc.hasSuffix(":*") ? String(rc.dropLast(2)) : rc
        }
        return rule.toolName
    }

    /// Leading command word(s) to auto-allow: skip `FOO=bar` assignments, take the program
    /// word, and add one following sub-command word when it looks like one — so
    /// `git commit -m x` → "git commit" and `ls -la` → "ls". nil when there's no clean program.
    public static func bashPrefix(_ command: String) -> String? {
        let cmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty else { return nil }
        let toks = cmd.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
        var i = 0
        while i < toks.count, isEnvAssignment(toks[i]) { i += 1 }
        guard i < toks.count, isCleanProgram(toks[i]) else { return nil }
        let prog = toks[i]
        if i + 1 < toks.count, isSubcommand(toks[i + 1]) { return "\(prog) \(toks[i + 1])" }
        return prog
    }

    // Regex equivalents from the web (ASCII-only, like [A-Za-z…]):

    /// `^[A-Za-z_][A-Za-z0-9_]*=`
    static func isEnvAssignment(_ t: String) -> Bool {
        guard let eq = t.firstIndex(of: "="), eq != t.startIndex else { return false }
        let name = t[t.startIndex..<eq]
        guard let first = name.first, first == "_" || (first.isASCII && first.isLetter) else { return false }
        return name.allSatisfy { $0 == "_" || ($0.isASCII && ($0.isLetter || $0.isNumber)) }
    }

    /// `^[A-Za-z./_-][\w./-]*$`
    static func isCleanProgram(_ s: String) -> Bool {
        guard let f = s.first, isProgFirst(f) else { return false }
        return s.allSatisfy(isProgRest)
    }
    private static func isProgFirst(_ c: Character) -> Bool {
        (c.isASCII && c.isLetter) || c == "." || c == "/" || c == "_" || c == "-"
    }
    private static func isProgRest(_ c: Character) -> Bool {
        (c.isASCII && (c.isLetter || c.isNumber)) || c == "_" || c == "." || c == "/" || c == "-"
    }

    /// `^[A-Za-z][\w-]*$`
    static func isSubcommand(_ s: String) -> Bool {
        guard let f = s.first, f.isASCII, f.isLetter else { return false }
        return s.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" || $0 == "-" }
    }
}
