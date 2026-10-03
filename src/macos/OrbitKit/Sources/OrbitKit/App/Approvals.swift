import Foundation

// Approval rendering + decision logic for the three card kinds:
//   • tool permission  → allow/deny (+ optional "remember same kind" rule)
//   • AskUserQuestion   → multiple-choice form; allow carries `answers`
//   • ExitPlanMode      → plan render; allow/deny
// Question/plan approvals are not repeatable, so they never get a remember rule. Ports the
// web's ApprovalPanel logic (bashCommandRules / rememberRulesFor) so behavior matches exactly;
// `src/shared/src/bash-rules.fixture.json` holds the cases both ends are proved against.

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
    /// Orbit's own asks, raised by the runner's MCP tools rather than by the engine's permission
    /// prompt: a batch of new tasks, and a restructure of a list's dependency graph. Both carry a
    /// server-computed `preview` of what would happen, and both are rendered as their own card.
    public static func isTaskBatch(toolName: String) -> Bool { toolName == "orbit_task_batch" }
    public static func isDagChange(toolName: String) -> Bool { toolName == "orbit_dag_change" }
    /// The single creates, asked the same way: nothing is created on the owner's behalf without
    /// their yes. These carry the body about to be written rather than a preview.
    public static func isTaskCreate(toolName: String) -> Bool { toolName == "orbit_task_create" }
    public static func isProjectCreate(toolName: String) -> Bool { toolName == "orbit_project_create" }
    /// Ending one of a project's blockers: the one ask here that creates nothing. The blocker IS
    /// the project saying it needs a person, so the agent's part is to argue the condition is gone
    /// and the owner's is to agree or not. Web keys the same tool off `isBlockerResolve`.
    public static func isBlockerResolve(toolName: String) -> Bool { toolName == "orbit_blocker_resolve" }
    /// Every ask Orbit raises for itself. What they share is how they are answered: a refusal is a
    /// conversation rather than a press (the composer is armed with the reason), and none of them
    /// can be waived with a standing rule — what is being asked for differs each time.
    public static func isOrbitAsk(toolName: String) -> Bool {
        isTaskBatch(toolName: toolName) || isDagChange(toolName: toolName)
            || isTaskCreate(toolName: toolName) || isProjectCreate(toolName: toolName)
            || isBlockerResolve(toolName: toolName)
    }
    /// A provider write — one of the owner's own providers created, changed or removed. Drawn and
    /// refused as a plain tool card (its input is the provider as it would be written, the key
    /// reduced to the fact that one is set), but never waived with a standing rule: that would be a
    /// yes to whatever endpoint and key the next one names. Web keys it off `isProviderWrite`.
    public static func isProviderWrite(toolName: String) -> Bool {
        toolName == "orbit_provider_create" || toolName == "orbit_provider_update"
            || toolName == "orbit_provider_delete"
    }

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

    // MARK: declining one of Orbit's own asks
    //
    // Saying no to a batch of tasks, a create or a restructure is a position, not a misfire: the
    // agent proposed something and the answer is "not this". So the decline hands the composer the
    // same reply the question card does — the refusal and what to do instead ride back together as
    // one deny+message, rather than the agent learning only that it was refused and guessing.
    // A plain tool-permission `Deny` keeps its old one-press meaning: refusing a shell command is
    // not a proposal being discussed, and asking for a sentence first would be a tax on saying no.

    /// What every card calls the control that hands its reply to the composer: a question's, one
    /// of Orbit's own asks, and the confirmation card's (`OwnerConfirmations.sendBackAction`). One
    /// word, because it is one thing — the alternative was three buttons doing the same thing under
    /// three names.
    public static let chatAction = "Chat about this"

    /// What the composer's bar says it is declining, ahead of the ask's own subject.
    public static func decliningPrefix(toolName: String) -> String {
        if isDagChange(toolName: toolName) { return "Leaving the graph alone: " }
        if isBlockerResolve(toolName: toolName) { return "Leaving this open: " }
        return "Not creating: "
    }

    /// What the empty composer asks for while a decline is armed.
    public static let declinePlaceholder = "Say what to do instead…"

    private static func trimmed(_ s: String?) -> String {
        (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: remember-rule (allow + remember same kind)

    /// The rules for "allow + remember", or none when it doesn't apply: questions/plans aren't
    /// repeatable, and a Bash command with no clean prefix can't be generalized. A Bash line yields
    /// one rule per distinct sub-command (`bashCommandRules`); other tools get a tool-wide rule (no
    /// `ruleContent`). The running session stops asking, and the control plane keeps the rules on
    /// that session's workspace so its other sessions start with them too.
    public static func rememberRules(toolName: String, input: JSONValue) -> [PermissionRule] {
        // Orbit's own asks have no repeatable form. Every batch creates a different set of tasks
        // and every restructure releases a different set, so "always allow" would be a standing
        // yes to whatever comes next — which is the gate switched off, not a preference. Web
        // refuses it for the same reason; without this the two clients disagree about whether the
        // approval can be waived, and the weaker one wins.
        // Orbit's own asks are all in that family, ending a blocker included: "always let this
        // session clear whatever stops its project" is the one rule that would make every card
        // after it a formality. (The blocker ask could not have worked with a rule anyway — it
        // comes from the runner's own gate, which asks every time whatever the engine holds.)
        if isQuestion(toolName: toolName) || isPlan(toolName: toolName)
            || isOrbitAsk(toolName: toolName) || isProviderWrite(toolName: toolName) { return [] }
        if toolName == "Bash" {
            guard let cmd = input["command"]?.stringValue else { return [] }
            return bashCommandRules(cmd)
        }
        return [PermissionRule(toolName: toolName)]
    }

    /// What each rule is called on the button: a Bash rule's command prefix ("git commit:*" →
    /// "git commit"), otherwise the tool's name. Web: `ruleNames`.
    public static func ruleNames(_ rules: [PermissionRule]) -> [String] {
        rules.map { rule in
            if rule.toolName == "Bash", let rc = rule.ruleContent, !rc.isEmpty {
                return rc.hasSuffix(":*") ? String(rc.dropLast(2)) : rc
            }
            return rule.toolName
        }
    }

    /// The scope shown on the "remember" button, capped at four names so a long compound line stays
    /// readable ("cd, git add, echo, grep +2"). Web: `rememberLabel`.
    public static func rememberLabel(_ rules: [PermissionRule]) -> String {
        let names = ruleNames(rules)
        return names.count <= 4
            ? names.joined(separator: ", ")
            : "\(names.prefix(4).joined(separator: ", ")) +\(names.count - 4)"
    }

    /// One rule per distinct sub-command of a Bash line, so `cd x && git add …` remembers both `cd`
    /// and `git add`, not just the leading `cd`. Empty when the line is blank, when no sub-command
    /// has a clean prefix, or when any of them is a shell wrapper. A port of `bashCommandRules` in
    /// `@orbit/shared`.
    public static func bashCommandRules(_ command: String) -> [PermissionRule] {
        guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let segments = bashSegments(command)
        // Codex sends commands as `/bin/bash -lc '…'`. Remembering the wrapper would be a standing
        // grant for arbitrary shell code, and a line with a wrapper anywhere in it is equally unsafe
        // to summarize by prefixes.
        if segments.contains(where: isBashShellWrapperCommand) { return [] }
        var seen = Set<String>()
        var rules: [PermissionRule] = []
        for segment in segments {
            if let prefix = bashPrefix(segment), seen.insert(prefix).inserted {
                rules.append(PermissionRule(toolName: "Bash", ruleContent: "\(prefix):*"))
            }
        }
        return rules
    }

    /// A shell line's top-level sub-commands, split at unquoted `;` `&&` `||` `|` and newlines.
    /// Quote- and backslash-aware, so an operator inside a quoted string stays literal (the `|` in
    /// `grep "a\|b"`). Best-effort, not a full shell parser. A port of `bashSegments` in
    /// `@orbit/shared`, walked by scalar like the web walks by code unit — a `\r\n` is one
    /// `Character`, and the newline in it must still split.
    public static func bashSegments(_ command: String) -> [String] {
        let chars = Array(command.unicodeScalars)
        var out: [String] = []
        var cur = String.UnicodeScalarView()
        var quote: Unicode.Scalar?
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\", i + 1 < chars.count {
                cur.append(c)
                cur.append(chars[i + 1])
                i += 2
                continue
            }
            if let open = quote {
                cur.append(c)
                if c == open { quote = nil }
                i += 1
                continue
            }
            if c == "\"" || c == "'" {
                quote = c
                cur.append(c)
                i += 1
                continue
            }
            if c == ";" || c == "\n" {
                out.append(String(cur))
                cur = String.UnicodeScalarView()
                i += 1
                continue
            }
            if c == "&" || c == "|", i + 1 < chars.count, chars[i + 1] == c {
                out.append(String(cur))
                cur = String.UnicodeScalarView()
                i += 2
                continue
            }
            if c == "|" {
                out.append(String(cur))
                cur = String.UnicodeScalarView()
                i += 1
                continue
            }
            cur.append(c)
            i += 1
        }
        out.append(String(cur))
        return out
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

    /// Whether one sub-command runs a shell with `-c`/`-lc`-style command execution. Codex wraps
    /// shell calls as `/bin/bash -lc '…'`, and a remember rule for that outer command would grant
    /// arbitrary shell code. A port of `isBashShellWrapperCommand` in `@orbit/shared`.
    public static func isBashShellWrapperCommand(_ segment: String) -> Bool {
        let toks = segment.split(whereSeparator: \.isWhitespace).map(String.init)
        var i = 0
        while i < toks.count, isEnvAssignment(toks[i]) { i += 1 }
        guard i < toks.count,
              ["bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh", "/usr/bin/sh",
               "zsh", "/bin/zsh", "/usr/bin/zsh"].contains(toks[i]),
              i + 1 < toks.count else { return false }
        let option = toks[i + 1]
        if option == "--command" { return true }
        // `^-[A-Za-z]*c[A-Za-z]*$`
        guard option.first == "-" else { return false }
        let flags = option.dropFirst()
        return flags.contains("c") && flags.allSatisfy { $0.isASCII && $0.isLetter }
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
