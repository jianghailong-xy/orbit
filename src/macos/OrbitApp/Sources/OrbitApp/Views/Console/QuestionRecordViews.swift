import SwiftUI
import OrbitKit

// An agent's question (AskUserQuestion) once it has ended, as the transcript's tool card draws it
// (`docs/mocks/ask-question-card-ios/`). Folded, the card is the record: what was asked, in its
// opening, and how it was answered. A tap replays the question and every option as they were
// offered, the pick ticked — the way the coordinator's answered question replays in its sheet.
// How it ended is read off the result (`QuestionRecords`); every word is shared with the browser
// (`question-record.fixture.json`).

/// The folded card's lines under its row: each question's opening, then its answer. One question
/// keeps two lines of its opening and several keep one each, so the card stays a record instead
/// of becoming the replay.
struct QuestionFoldedLines: View {
    let questions: [AskQuestion]
    let outcome: QuestionOutcome?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                Text(QuestionRecords.lead(question.question))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(questions.count > 1 ? 1 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, index > 0 ? 4 : 0)
                if let line = QuestionRecords.answerLine(question, answer(index)) {
                    answerRow(symbol: "checkmark.circle.fill") {
                        Text(line).font(.orbitProseAside).lineLimit(2)
                    }
                }
            }
            if case .replied(let words) = outcome {
                answerRow(symbol: "bubble.left.fill") {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(QuestionRecords.replyLine(words)).font(.orbitProseAside).lineLimit(2)
                        Text(QuestionRecords.repliedInChat).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func answer(_ index: Int) -> QuestionAnswer? {
        guard case .answered(let answers) = outcome, answers.indices.contains(index) else { return nil }
        return answers[index]
    }

    private func answerRow<Words: View>(symbol: String, @ViewBuilder words: () -> Words) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.orbitLabel).foregroundStyle(Color.blue)
            words()
            Spacer(minLength: 0)
        }
    }
}

/// The unfolded card: every question as it was asked and every option as it was offered, with its
/// description — the pick ticked on a light blue, the rest grey but readable — then the words typed
/// instead of an option, or the reply given in the conversation instead of any.
///
/// Every text here takes its whole height (`fixedSize` vertically): the transcript's List cell
/// measured the baseline-aligned option rows short and cut each description at two lines with an
/// ellipsis (the iPhone probe's pictures, run 38018707522) — a replay that drops the end of a sentence
/// is not one.
struct QuestionReplayView: View {
    let questions: [AskQuestion]
    let outcome: QuestionOutcome?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                if index > 0 { Divider().padding(.vertical, 2) }
                block(question, answer(index))
            }
            if case .replied(let words) = outcome {
                wordsBox(label: QuestionRecords.repliedInChat, words: words)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func block(_ question: AskQuestion, _ answer: QuestionAnswer?) -> some View {
        // A header is the only way to tell several questions apart at a glance; one question's
        // header is already in the row. "Multiple choice" sits on that line, as it does when asked.
        let header = (question.header ?? "").isEmpty || questions.count == 1 ? nil : question.header
        if header != nil || question.multiSelect {
            HStack(spacing: 6) {
                if let header {
                    Text(header.uppercased())
                        .font(.orbitSectionLabel.weight(.semibold)).tracking(0.4)
                        .foregroundStyle(.secondary)
                }
                if question.multiSelect {
                    Text(QuestionRecords.multipleChoice)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.primary.opacity(0.07), in: Capsule())
                }
            }
        }
        Text(question.question)
            .font(.orbitProseAside)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                optionRow(option, picked: answer?.picked.contains(index) == true, multiSelect: question.multiSelect)
            }
        }
        if let typed = answer?.typed {
            wordsBox(label: QuestionRecords.yourAnswer, words: typed)
        }
    }

    private func answer(_ index: Int) -> QuestionAnswer? {
        guard case .answered(let answers) = outcome, answers.indices.contains(index) else { return nil }
        return answers[index]
    }

    /// One option as it was offered, ticked when it is the answer. The glyph says what kind of
    /// question it was, as the asking card's does: a square where several could be picked.
    private func optionRow(_ option: AskOption, picked: Bool, multiSelect: Bool) -> some View {
        let glyph = multiSelect ? (picked ? "checkmark.square.fill" : "square")
                                : (picked ? "checkmark.circle.fill" : "circle")
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: glyph)
                .font(.orbitLabel)
                .foregroundStyle(picked ? Color.blue : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label).font(.orbitProseAside)
                    .foregroundStyle(picked ? Color.primary : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let why = option.description, !why.isEmpty {
                    Text(why).font(.orbitLabel)
                        .foregroundStyle(picked ? HierarchicalShapeStyle.secondary : HierarchicalShapeStyle.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(picked ? Color.blue.opacity(0.08) : Color.clear,
                    in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// The person's own words, read-only: typed instead of an option, or replied in the conversation.
    private func wordsBox(label: String, words: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.orbitLabel).foregroundStyle(.secondary)
            Text(words).font(.orbitProseAside).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }
}
