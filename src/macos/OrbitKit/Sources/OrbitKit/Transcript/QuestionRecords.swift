import Foundation

// How an agent's question (`AskUserQuestion`) ended, read back from the one record of it a client
// is given: the result text the engine wrote for the agent. A hand-copy of the browser's reader,
// `@orbit/shared`'s `questionRecord.ts`; `question-record.fixture.json` is the set of cases both are
// proved against (`QuestionRecordsTests`), so the two clients cannot read one answer two ways.
//
// The answer is not kept anywhere a client reads. Orbit hands it to the engine as
// `updatedInput.answers` (question text → labels, the runner's `askQuestionInput`), and claude
// writes the result from it — `The user answered: "<question>"="<answer>", …. Read the answers…`,
// or `Your questions have been answered: …` when every answer is a pick of a multi-select question.
// A multi-select answer is its labels joined by a bare comma, with any typed words last. "Chat
// about this" answers the question as a refusal whose message is the person's own words, so that
// result is an error and its whole text is the reply.

/// One question's answer: the options picked, by their index in the order offered, and the words
/// typed instead of (or, on a multi-select question, beside) a listed option.
public struct QuestionAnswer: Equatable, Sendable {
    public let picked: [Int]
    public let typed: String?

    public init(picked: [Int], typed: String?) {
        self.picked = picked
        self.typed = typed
    }
}

/// How the question ended: one answer per question (nil where the result names none), or the reply
/// given in the conversation instead of any pick.
public enum QuestionOutcome: Equatable, Sendable {
    case answered([QuestionAnswer?])
    case replied(String)
}

public enum QuestionRecords {
    /// Under a reply given in the conversation instead of a pick, and over it once the card opens.
    public static let repliedInChat = "Replied in chat"
    /// Over the words typed instead of a listed option, once the card opens.
    public static let yourAnswer = "Your answer"
    /// Beside a question that took several picks: the words the question card itself uses.
    public static let multipleChoice = "Multiple choice"

    /// Error results that are the call failing rather than a person replying.
    static let failurePrefixes = ["<tool_use_error>", "approval poll failed"]
    /// The runner's refusal when no words came with it: nobody said anything.
    static let bareDenial = "denied by the user"

    /// A question's opening, for the folded card: one line of text, however the agent broke it.
    public static func lead(_ question: String) -> String {
        question.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The folded card's answer line: the picked options' labels, then any typed words in quotes,
    /// joined by " · ". Nil when the result names no answer to this question.
    public static func answerLine(_ question: AskQuestion, _ answer: QuestionAnswer?) -> String? {
        guard let answer else { return nil }
        var parts = answer.picked.compactMap { question.options.indices.contains($0) ? question.options[$0].label : nil }
            .filter { !$0.isEmpty }
        if let typed = answer.typed { parts.append("“\(typed)”") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A reply given in the conversation instead of a pick, as the folded card quotes it.
    public static func replyLine(_ words: String) -> String { "“\(words)”" }

    /// Read how the questions ended from the call's result. Nil when the result says neither — no
    /// result yet, a failure, or a wording this reader does not know — and the card then shows the
    /// result as it was written.
    public static func outcome(questions: [AskQuestion], result: String?, isError: Bool) -> QuestionOutcome? {
        let written = (result ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if written.isEmpty { return nil }
        if isError {
            if written == bareDenial || failurePrefixes.contains(where: { written.hasPrefix($0) }) { return nil }
            return .replied(written)
        }
        // Where each answer starts — right after `"<question>"="` — and where its pair does.
        let found: [(pair: String.Index, start: String.Index)?] = questions.map { q in
            guard !q.question.isEmpty,
                  let at = written.range(of: "\"\(q.question)\"=\"", options: .literal) else { return nil }
            return (at.lowerBound, at.upperBound)
        }
        let answers: [QuestionAnswer?] = questions.indices.map { i in
            guard let here = found[i] else { return nil }
            // An answer runs to the next pair, or to the end; its closing quote is the last one
            // before that. The sentence after the last pair holds none, and neither does `, `.
            let next = found.compactMap { $0?.pair }.filter { $0 > here.start }.min() ?? written.endIndex
            guard let close = written.range(of: "\"", options: [.literal, .backwards], range: here.start..<next)
            else { return nil }
            return read(questions[i], String(written[here.start..<close.lowerBound]))
        }
        return answers.contains(where: { $0 != nil }) ? .answered(answers) : nil
    }

    /// One answer's words as the picks they name and the words left over.
    private static func read(_ q: AskQuestion, _ words: String) -> QuestionAnswer? {
        if words.isEmpty { return nil }
        let labels = q.options.map(\.label)
        guard q.multiSelect else {
            // One option, or the person's own words — the question card keeps the two apart.
            if let at = labels.firstIndex(of: words) { return QuestionAnswer(picked: [at], typed: nil) }
            return QuestionAnswer(picked: [], typed: words)
        }
        // Labels joined by commas, typed words last. A label may hold a comma itself, so each step
        // takes the longest label the rest starts with that ends where a comma or the answer does.
        var picked: [Int] = []
        var rest = Substring(words)
        while true {
            var best: Int?
            for (k, label) in labels.enumerated() where !label.isEmpty && !picked.contains(k) {
                guard rest.hasPrefix(label) else { continue }
                let after = rest.dropFirst(label.count)
                guard after.isEmpty || after.first == "," else { continue }
                if best == nil || label.count > labels[best!].count { best = k }
            }
            guard let best else { break }
            picked.append(best)
            rest = rest.dropFirst(labels[best].count + 1)
        }
        let typed = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        return QuestionAnswer(picked: picked.sorted(), typed: typed.isEmpty ? nil : typed)
    }
}
