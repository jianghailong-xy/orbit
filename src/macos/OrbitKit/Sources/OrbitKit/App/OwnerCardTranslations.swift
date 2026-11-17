import Foundation

// Settings › Translation on the owner cards that live outside a session (board
// docs/mocks/session-translation/04-owner-cards.html, frames 1–4; decision 4A): a coordinator's
// question, start and done requests, owner requests, owner confirmations, completion evidence,
// criteria-change proposals and crossings. Each card is drawn from a copy of itself in the owner's
// language when the server stored a translation in that language, with one foot — "Translated · Show
// original" ↔ "Original · Show translation" — that flips the whole card; with no translation, a failed
// one, or translation off, it is drawn as the agent wrote it and has no foot. An answer the server
// refuses with 422 TRANSLATION_FAILED is not sent: the card says "Couldn't translate, so it wasn't
// sent · Retry · Send as written". Copy is `TranslationCopy`, the web's words. The cards only draw
// what these return; what to SEND (an option's index, the gaps a done press accepts) is always read
// off the original.

public enum OwnerCardTranslations {

    /// The language owner cards are drawn in: the owner's, while their translation is on and the
    /// server can translate; nil otherwise, which draws every card as the agent wrote it.
    public static func ownerLanguage(_ user: User?) -> TranslationLanguage? {
        SessionTranslation.isOn(user) ? SessionTranslation.language(user?.preferences) : nil
    }

    /// The translation a card is drawn from: one in the owner's language that did not fail.
    public static func usable(_ t: OwnerCardTranslation?, owner: TranslationLanguage?) -> OwnerCardTranslation? {
        guard let t, let owner, !t.failed, t.lang == owner.rawValue else { return nil }
        return t
    }

    public static func usable(_ t: EvidenceTranslation?, owner: TranslationLanguage?) -> EvidenceTranslation? {
        guard let t, let owner, !t.failed, t.lang == owner.rawValue else { return nil }
        return t
    }

    /// The foot under a card whose translation changes something it draws: "Translated · Show
    /// original", or "Original · Show translation" once flipped. Nothing when it changes nothing.
    public static func foot(translates: Bool, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        guard translates else { return [] }
        return showOriginal
            ? [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]
            : [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
    }

    /// The line under an answer the server refused because the owner's words could not be translated
    /// (422 TRANSLATION_FAILED, nothing recorded): the same words, presses and order as a refused
    /// approval answer. On an owner card `.retryTurn` sends the answer again and `.sendAsWritten`
    /// sends it with `sendAsWritten: true`.
    public static let refusedFoot: [SessionTranslation.FootPart] = [
        .text(TranslationCopy.sendFailed),
        .action(TranslationCopy.retry, .retryTurn),
        .action(TranslationCopy.sendAsWritten, .sendAsWritten),
    ]

    /// Whether an answer's failure is that refusal, which the card answers with `refusedFoot` rather
    /// than its ordinary error line.
    public static func refused(_ error: Error?) -> Bool {
        guard let error else { return false }
        return SessionTranslation.refusedUntranslated(error)
    }

    /// The foot under an answer box after a send: `refusedFoot` for a TRANSLATION_FAILED refusal,
    /// nothing for anything else (an ordinary failure keeps its own error line).
    public static func answerFoot(after error: Error?) -> [SessionTranslation.FootPart] {
        refused(error) ? refusedFoot : []
    }

    // MARK: field rules

    /// The translated words over the original, when both have text.
    static func over(_ original: String, _ translated: String?) -> String {
        guard !original.isEmpty, let translated, !translated.isEmpty else { return original }
        return translated
    }

    static func over(_ original: String?, _ translated: String?) -> String? {
        guard let original else { return nil }
        return over(original as String, translated) as String
    }

    static func at<T>(_ array: [T]?, _ i: Int) -> T? {
        guard let array, i < array.count else { return nil }
        return array[i]
    }
}

// MARK: - a coordinator's question, start request and done request

public extension CoordinatorQuestion {
    /// The question with its words, options and ifUnanswered in the translation's language.
    func translated(_ t: OwnerCardTranslation) -> CoordinatorQuestion {
        var q = self
        q.question = OwnerCardTranslations.over(question, t.question)
        q.ifUnanswered = OwnerCardTranslations.over(ifUnanswered, t.ifUnanswered)
        q.options = options.enumerated().map { i, o in
            var o = o
            let to = OwnerCardTranslations.at(t.options, i)
            o.label = OwnerCardTranslations.over(o.label, to?.label)
            o.description = OwnerCardTranslations.over(o.description, to?.description)
            return o
        }
        return q
    }
}

public extension ProjectStartRequest {
    func translated(_ t: OwnerCardTranslation) -> ProjectStartRequest {
        var r = self
        r.why = OwnerCardTranslations.over(why, t.why)
        return r
    }
}

public extension DoneRequest {
    /// The request as drawn. Never what a press sends: the gaps the owner accepts go back as the
    /// coordinator wrote them.
    func translated(_ t: OwnerCardTranslation) -> DoneRequest {
        var r = self
        r.judgment = OwnerCardTranslations.over(judgment, t.judgment)
        r.gaps = gaps.enumerated().map { i, gap in
            guard let tg = OwnerCardTranslations.at(t.gaps, i) else { return gap }
            var gap = gap
            for (key, value) in [("title", tg.title), ("whyNotProven", tg.whyNotProven),
                                 ("coordinatorChecked", tg.coordinatorChecked)] {
                if let original = gap.fields[key]?.stringValue {
                    gap.fields[key] = .string(OwnerCardTranslations.over(original, value))
                }
            }
            return gap
        }
        return r
    }
}

public extension ProjectOpenItemRow {
    private func shownTranslation(_ owner: TranslationLanguage?, _ showOriginal: Bool) -> OwnerCardTranslation? {
        showOriginal ? nil : OwnerCardTranslations.usable(translation, owner: owner)
    }

    /// A `COORDINATOR_QUESTION`'s question as the card draws it.
    func shownQuestion(owner: TranslationLanguage?, showOriginal: Bool) -> CoordinatorQuestion? {
        guard let question, let t = shownTranslation(owner, showOriginal) else { return question }
        return question.translated(t)
    }

    /// A `START_REQUEST`'s request as the card draws it.
    func shownStartRequest(owner: TranslationLanguage?, showOriginal: Bool) -> ProjectStartRequest? {
        guard let startRequest, let t = shownTranslation(owner, showOriginal) else { return startRequest }
        return startRequest.translated(t)
    }

    /// A `DONE_REQUEST`'s request as the card draws it; a press still sends `doneRequest`.
    func shownDoneRequest(owner: TranslationLanguage?, showOriginal: Bool) -> DoneRequest? {
        guard let doneRequest, let t = shownTranslation(owner, showOriginal) else { return doneRequest }
        return doneRequest.translated(t)
    }

    /// The card's one foot, which flips all of the above together.
    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        let translates = shownQuestion(owner: owner, showOriginal: false) != question
            || shownStartRequest(owner: owner, showOriginal: false) != startRequest
            || shownDoneRequest(owner: owner, showOriginal: false) != doneRequest
        return OwnerCardTranslations.foot(translates: translates, showOriginal: showOriginal)
    }
}

public extension ProjectClosedQuestion {
    /// The answered question's record as drawn: the question as asked, in the owner's language.
    func shownQuestion(owner: TranslationLanguage?, showOriginal: Bool) -> CoordinatorQuestion {
        guard !showOriginal, let t = OwnerCardTranslations.usable(translation, owner: owner) else { return question }
        return question.translated(t)
    }

    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        OwnerCardTranslations.foot(translates: shownQuestion(owner: owner, showOriginal: false) != question,
                                   showOriginal: showOriginal)
    }
}

// MARK: - an owner request

public extension OwnerRequest {
    /// The request as drawn: title, why, ifUnanswered, options, the steps' text and verifyHint in the
    /// owner's language. A step's command and link stay the original's; an option is answered by index.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> OwnerRequest {
        guard !showOriginal, let t = OwnerCardTranslations.usable(translation, owner: owner) else { return self }
        var r = self
        r.title = OwnerCardTranslations.over(title, t.title)
        r.why = OwnerCardTranslations.over(why, t.why)
        r.ifUnanswered = OwnerCardTranslations.over(ifUnanswered, t.ifUnanswered)
        r.verifyHint = OwnerCardTranslations.over(verifyHint, t.verifyHint)
        r.options = options?.enumerated().map { i, o in
            var o = o
            let to = OwnerCardTranslations.at(t.options, i)
            o.label = OwnerCardTranslations.over(o.label, to?.label)
            o.description = OwnerCardTranslations.over(o.description, to?.description)
            return o
        }
        r.steps = steps?.enumerated().map { i, s in
            var s = s
            s.text = OwnerCardTranslations.over(s.text, OwnerCardTranslations.at(t.steps, i)?.text)
            return s
        }
        return r
    }

    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        OwnerCardTranslations.foot(translates: shown(owner: owner, showOriginal: false) != self,
                                   showOriginal: showOriginal)
    }
}

// MARK: - an owner confirmation: the run's report and its review

public extension OwnerConfirmationReport {
    /// The report as drawn: its run event's translation when that is in the owner's language.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> OwnerConfirmationReport {
        guard !showOriginal, let owner, let t = translation, !t.failed, t.lang == owner,
              let text = t.text, !text.isEmpty else { return self }
        var r = self
        r.text = text
        return r
    }
}

public extension OwnerConfirmationReviewView {
    /// The review as drawn: the REVIEW record's judgment and needsYou (and the headline the server
    /// took from the first of them), and the PROBLEMS record's reason and problems.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> OwnerConfirmationReviewView {
        guard !showOriginal else { return self }
        var v = self
        if let record = review, let t = OwnerCardTranslations.usable(record.translation, owner: owner) {
            var r = record
            r.judgment = OwnerCardTranslations.over(record.judgment, t.judgment)
            r.needsYou = record.needsYou.enumerated().map { i, item in
                var item = item
                let ti = OwnerCardTranslations.at(t.needsYou, i)
                item.text = OwnerCardTranslations.over(item.text, ti?.text)
                item.options = item.options.enumerated().map { j, o in
                    var o = o
                    let to = OwnerCardTranslations.at(ti?.options, j)
                    o.label = OwnerCardTranslations.over(o.label, to?.label)
                    o.description = OwnerCardTranslations.over(o.description, to?.description)
                    return o
                }
                return item
            }
            v.review = r
            if case .needsYou(let text, let more)? = headline, let first = record.needsYou.first,
               text == first.text, let shownFirst = r.needsYou.first {
                v.headline = .needsYou(text: shownFirst.text, more: more)
            }
        }
        if let record = problems, let t = OwnerCardTranslations.usable(record.translation, owner: owner) {
            var p = record
            p.reason = OwnerCardTranslations.over(record.reason, t.reason)
            p.problems = record.problems.enumerated().map { i, item in
                var item = item
                item.text = OwnerCardTranslations.over(item.text, OwnerCardTranslations.at(t.problems, i)?.text)
                return item
            }
            v.problems = p
        }
        return v
    }
}

public extension OwnerCardTranslations {
    /// The confirmation card's one foot: the report and the review flip together.
    static func confirmationFoot(report: OwnerConfirmationReport?, review: OwnerConfirmationReviewView?,
                                 owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        let translates = report?.shown(owner: owner, showOriginal: false) != report
            || review?.shown(owner: owner, showOriginal: false) != review
        return foot(translates: translates, showOriginal: showOriginal)
    }
}

// MARK: - completion evidence

public extension EvidenceDecisionRow {
    /// The row as drawn: claim and gaps in the owner's language. A decision still names the revision.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> EvidenceDecisionRow {
        guard !showOriginal, let t = OwnerCardTranslations.usable(translation, owner: owner) else { return self }
        var r = self
        r.claim = OwnerCardTranslations.over(claim, t.claim)
        r.gaps = gaps.enumerated().map { i, g in OwnerCardTranslations.over(g, OwnerCardTranslations.at(t.gaps, i)) }
        return r
    }

    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        OwnerCardTranslations.foot(translates: shown(owner: owner, showOriginal: false) != self,
                                   showOriginal: showOriginal)
    }
}

// MARK: - a criteria-change proposal

public extension PendingCriteriaDecisionRow {
    /// The proposal as drawn: each proposed criterion's text and verification method in the owner's
    /// language, in `proposed` and in the diff entry of the same ordinal. A translated entry loses its
    /// word-level cut (taken over the agent's words), so the card draws the two versions whole. The
    /// answer still carries the proposal's `actionDigest`, which is over the original.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> PendingCriteriaDecisionRow {
        guard !showOriginal, let t = OwnerCardTranslations.usable(translation, owner: owner),
              let translated = t.proposed else { return self }
        var r = self
        var byOrdinal: [Int: TranslatedCriterionItem] = [:]
        r.proposed = proposed.enumerated().map { i, c in
            guard let tc = OwnerCardTranslations.at(translated, i) else { return c }
            byOrdinal[c.ordinal] = tc
            var c = c
            c.text = OwnerCardTranslations.over(c.text, tc.text)
            c.verificationMethod = OwnerCardTranslations.over(c.verificationMethod, tc.verificationMethod)
            return c
        }
        r.diff.entries = diff.entries.map { entry in
            guard let wording = entry.proposed, let tc = byOrdinal[entry.ordinal] else { return entry }
            var w = wording
            w.text = OwnerCardTranslations.over(wording.text, tc.text)
            w.verificationMethod = OwnerCardTranslations.over(wording.verificationMethod, tc.verificationMethod)
            guard w != wording else { return entry }
            var e = entry
            e.proposed = w
            e.rewrites = []
            return e
        }
        return r
    }

    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        OwnerCardTranslations.foot(translates: shown(owner: owner, showOriginal: false) != self,
                                   showOriginal: showOriginal)
    }
}

// MARK: - a crossing

public extension ProjectCrossing {
    /// The crossing as drawn: its title and reason in the owner's language.
    func shown(owner: TranslationLanguage?, showOriginal: Bool) -> ProjectCrossing {
        guard !showOriginal, let t = OwnerCardTranslations.usable(translation, owner: owner) else { return self }
        var c = self
        c.title = OwnerCardTranslations.over(title, t.title)
        c.reason = OwnerCardTranslations.over(reason, t.reason)
        return c
    }

    func translationFoot(owner: TranslationLanguage?, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        OwnerCardTranslations.foot(translates: shown(owner: owner, showOriginal: false) != self,
                                   showOriginal: showOriginal)
    }
}
