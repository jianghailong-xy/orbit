package io.orbitd.android.projects

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Android start card says main's `StartProject.swift` words: OrbitKit's `StartProjectCardCopyParityTests` and the start
 * half of `ProjectRunSettingsCopyParityTests`, pointed at the Swift source instead of the browser's. Every fixed word is
 * declared there under the same name, and every built sentence — rendered here with sentinels, which are put back as Swift's
 * own interpolations — is one literal there, so the words either side of a number are held too. A missing counterpart is a
 * failure, never a skip (ProjectCopyParityTest's rule, which holds every constant as a literal). */
class StartProjectCardCopyTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    /** A Swift source with `"a " + "b"` put back together and a value on the line under its `=` pulled up. */
    private fun swift(name: String) = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/$name").readText()
        .replace(Regex("\"\\s*\\+\\s*\""), "")
        .replace(Regex("=\\s*\\n\\s*\""), "= \"")
    private val start = swift("StartProject.swift")
    private val page = swift("ProjectRunSettings.swift")

    /** Sentinels that occur in no sentence. */
    private val count = 23
    private val n = "$count"

    private fun assertDeclares(source: String, name: String, value: String) =
        assertTrue("$name drifted: the Swift no longer declares it as \"$value\"", source.contains("static let $name = \"$value\""))

    private fun assertSentence(source: String, rendered: String, values: List<Pair<String, String>>, what: String) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("$what drifted: the Swift no longer contains \"$template\"", source.contains("\"$template\""))
    }

    @Test fun theCardsFixedWordsAreDeclaredUnderTheirSwiftNames() {
        listOf("title" to StartProjectCopy.title, "readyToStart" to StartProjectCopy.readyToStart, "doneWhen" to StartProjectCopy.doneWhen,
            "plan" to StartProjectCopy.plan, "howItRuns" to StartProjectCopy.howItRuns, "viewTasks" to StartProjectCopy.viewTasks,
            "action" to StartProjectCopy.action, "nobodyAsked" to StartProjectCopy.nobodyAsked, "noCoordinatorYet" to StartProjectCopy.noCoordinatorYet,
            "coordinator" to StartProjectCopy.coordinator, "more" to StartProjectCopy.more, "less" to StartProjectCopy.less,
            "notRecorded" to StartProjectCopy.notRecorded, "requestGone" to StartProjectCopy.requestGone, "opensCoordinator" to StartProjectCopy.opensCoordinator,
            "now" to StartProjectCopy.now, "you" to StartProjectCopy.you, "coordinatorAsked" to StartProjectCopy.coordinatorAsked,
            // What still comes to the owner, and whose settings these are.
            "comesToYou" to StartProjectCopy.comesToYou, "decideDone" to StartProjectCopy.decideDone, "youConfirm" to StartProjectCopy.youConfirm,
            "problems" to StartProjectCopy.problems, "problemsDetail" to StartProjectCopy.problemsDetail, "mergingIntoMain" to StartProjectCopy.mergingIntoMain,
            "eachMergeIntoMain" to StartProjectCopy.eachMergeIntoMain, "criteriaChanges" to StartProjectCopy.criteriaChanges,
            "automaticByDefault" to StartProjectCopy.automaticByDefault, "coordinatorSuggestedOff" to StartProjectCopy.coordinatorSuggestedOff,
            "restSuggested" to StartProjectCopy.restSuggested, "changeLater" to StartProjectCopy.changeLater,
        ).forEach { (name, value) -> assertDeclares(start, name, value) }
        // How it runs, as the start card draws it.
        listOf("tasksLandOn" to RunSettings.tasksLandOn, "lineProjectBranch" to RunSettings.lineProjectBranch, "lineProjectBranchHint" to RunSettings.lineProjectBranchHint,
            "lineMain" to RunSettings.lineMain, "lineMainHint" to RunSettings.lineMainHint, "automatic" to RunSettings.automatic,
            "automaticHintProjectBranch" to RunSettings.automaticHintProjectBranch, "automaticHintMain" to RunSettings.automaticHintMain,
            "atMost" to RunSettings.atMost, "mergeCheck" to RunSettings.mergeCheck, "mergeCheckHint" to RunSettings.mergeCheckHint,
            "mergeCheckPlaceholder" to RunSettings.mergeCheckPlaceholder, "noMergeCheckWarning" to RunSettings.noMergeCheckWarning,
            "automaticOnChecked" to RunSettings.automaticOnChecked, "automaticOnUnchecked" to RunSettings.automaticOnUnchecked,
            "automaticOnMain" to RunSettings.automaticOnMain, "automaticOff" to RunSettings.automaticOff, "automaticOffMain" to RunSettings.automaticOffMain,
            "mergeCheckSet" to RunSettings.mergeCheckSet, "mergeCheckNone" to RunSettings.mergeCheckNone, "mergeCheckNoneSays" to RunSettings.mergeCheckNoneSays,
        ).forEach { (name, value) -> assertDeclares(start, name, value) }
        // The page's half: the start's row and the tag of a project nobody has started.
        listOf("notStarted" to StartProjectCopy.notStarted, "rowAsked" to StartProjectCopy.rowAsked, "rowOwn" to StartProjectCopy.rowOwn,
            "rowNotAsked" to StartProjectCopy.rowNotAsked).forEach { (name, value) -> assertDeclares(page, name, value) }
        // The door's bound and the escalation window a read that does not say has.
        assertTrue(start.contains("static let maxConcurrentTasks = ${StartProjectCopy.maxConcurrentTasks}\n"))
        assertTrue(start.contains("static let defaultEscalationSeconds = 7_200\n"))
        assertEquals(7_200, StartProjectCopy.defaultEscalationSeconds)
    }

    @Test fun theSectionHeadsAndTheHeaderLineAreTheSwiftsWhole() {
        assertSentence(start, StartProjectCopy.doneWhenHead(count), listOf(StartProjectCopy.doneWhen to "\\(doneWhen)", n to "\\(count)",
            "criteria" to "\\(count == 1 ? \"criterion\" : \"criteria\")"), "the Done when head")
        assertEquals("${StartProjectCopy.doneWhen} · 1 criterion", StartProjectCopy.doneWhenHead(1))
        assertSentence(start, StartProjectCopy.planHead(count), listOf(StartProjectCopy.plan to "\\(plan)", n to "\\(count)",
            "tasks" to "\\(count == 1 ? \"task\" : \"tasks\")"), "the Plan head")
        assertEquals("${StartProjectCopy.plan} · 1 task", StartProjectCopy.planHead(1))
        assertTrue("the Swift no longer says how many levels the way this end does", start.contains("\"\\(head) in \\(levels) levels\""))
        assertEquals("${StartProjectCopy.planHead(count)} in 4 levels", StartProjectCopy.planHead(count, levels = 4))
        assertEquals(StartProjectCopy.planHead(count), StartProjectCopy.planHead(count, levels = 1))
        // Who asked, under the project's name; and the line of a card nobody asked for.
        assertSentence(start, StartProjectCopy.askedLine("AGO"), listOf(StartProjectCopy.coordinatorAsked to "\\(coordinatorAsked)", "AGO" to "\\(\$0)"),
            "who asked, and when")
        assertEquals(StartProjectCopy.coordinatorAsked, StartProjectCopy.askedLine(null))
        assertSentence(start, StartProjectCopy.nobodyAskedLine(hasCoordinator = false), listOf(StartProjectCopy.nobodyAsked to "\\(nobodyAsked)",
            StartProjectCopy.noCoordinatorYet to "\\(noCoordinatorYet)"), "a card nobody asked for, on a project with no coordinator")
        assertEquals(StartProjectCopy.nobodyAsked, StartProjectCopy.nobodyAskedLine(hasCoordinator = true))
    }

    @Test fun theParagraphsAndTheLineUnderStartAreTheSwiftsWhole() {
        assertSentence(start, StartProjectCopy.explanation(count), listOf(n to "\\(count)"), "what starting binds the project to")
        // Whose settings these are: the owner's default Automatic, and the coordinator's suggestion.
        assertTrue(start.contains("\"\\(automaticByDefault) (\\(coordinatorSuggestedOff)).\""))
        assertTrue(start.contains("\"\\(automaticByDefault).\""))
        assertEquals("${StartProjectCopy.automaticByDefault} (${StartProjectCopy.coordinatorSuggestedOff}). ${StartProjectCopy.restSuggested} ${StartProjectCopy.changeLater}",
            StartProjectCopy.howItRunsNote(asked = true, suggestedOff = true))
        assertEquals("${StartProjectCopy.automaticByDefault}. ${StartProjectCopy.changeLater}", StartProjectCopy.howItRunsNote(asked = false, suggestedOff = false))
        assertEquals("${StartProjectCopy.automaticByDefault}. ${StartProjectCopy.restSuggested} ${StartProjectCopy.changeLater}",
            StartProjectCopy.howItRunsNote(asked = true, suggestedOff = false))
        // What pressing Start does, part by part, and the first letter raised.
        listOf("\"opens a coordinator\"", "\"starts \\(joinAnd(startsNow)) now\"", "\"confirms this criterion\"", "\"confirms these \\(criteria) criteria\"",
            "\"seal \\(seal)\"", "parts.joined(separator: \" · \")", "line.prefix(1).uppercased() + line.dropFirst()").forEach {
            assertTrue("the Swift no longer builds the caption with $it", start.contains(it))
        }
        assertEquals("Starts X and Y now · confirms these $n criteria · seal qqqqzzzzqqqq", StartProjectCopy.barCaption(false, listOf("X", "Y"), count, "qqqqzzzzqqqq"))
        assertEquals("Opens a coordinator · confirms this criterion", StartProjectCopy.barCaption(true, emptyList(), 1, "qqqqzzzzqqqq"))
    }

    /** What still comes to the owner, in the words both ends build each line from. */
    @Test fun whatComesToTheOwnerIsSaidInTheSwiftsWords() {
        assertSentence(start, StartProjectCopy.reviews(count), listOf(n to "\\(count)", "reviews" to "\\(count == 1 ? \"review\" : \"reviews\")"), "the reviews")
        assertSentence(start, StartProjectCopy.tasksYouConfirm(count), listOf(n to "\\(count)"), "the tasks the owner confirms, counted")
        assertSentence(start, StartProjectCopy.problemsUnresolved("WITHIN"), listOf("WITHIN" to "\\(within)"), "what reaches the owner after the escalation window")
        assertSentence(start, StartProjectCopy.comesToYou(true, "PROJECT_BRANCH", listOf(StartProjectCopy.NamedTask("LABEL", "TITLE")), 0, 7_200).first().text,
            listOf("LABEL" to "\\(\$0.label)", "TITLE" to "\\(\$0.title)"), "a task the owner confirms")
        assertTrue(start.contains("\"\\(max(1, Int((Double(seconds) / 60).rounded()))) min\""))
        assertTrue(start.contains("\"\\(Int((Double(seconds) / 3600).rounded())) h\""))
        assertEquals("2 h", StartProjectCopy.within(7_200))
        assertEquals("1 min", StartProjectCopy.within(1))
    }

    /** The plan's own words: a level of several tasks, the names a list is joined with, and the rule that reads a label. */
    @Test fun thePlansWordsAreTheSwiftsWhole() {
        assertSentence(start, StartProjectCopy.inParallel(count), listOf(n to "\\(count)"), "a level of several tasks")
        assertTrue("the Swift no longer lists names as `A, B and C`",
            start.contains("\"\\(words.dropLast().joined(separator: \", \")) and \\(words[words.count - 1])\""))
        assertEquals("A, B and C", StartProjectCopy.joinAnd(listOf("A", "B", "C")))
        assertTrue("the Swift no longer reads P1a as a label the way this end does", start.contains("/^([A-Z]\\d{1,2}[a-z]?)(?:[.):：]|\\s)/u"))
        assertEquals("P1a", StartProjectCopy.planTaskLabel("P1a · wiki-worker"))
        assertSentence(start, RunSettings.tasksAtATime(count), listOf("tasks" to "\\(count == 1 ? \"task\" : \"tasks\")"), "the words after the number")
        assertEquals("task at a time", RunSettings.tasksAtATime(1))
    }

    /** The request's row on the project page and the undecided line, held to ProjectRunSettings.swift part by part. */
    @Test fun theStartsRowAndTheUndecidedLineAreTheSwiftsWords() {
        val suggestion = Json.parseToJsonElement("""{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":$count}""").jsonObject
        assertEquals("The coordinator asked · a project branch · Automatic on · at most $n at a time", StartProjectCopy.requestSummary(suggestion))
        assertEquals("The coordinator asked · directly into main · Automatic off · at most 1 at a time",
            StartProjectCopy.requestSummary(Json.parseToJsonElement("""{"line":"MAIN","automatic":false,"maxConcurrentTasks":1}""").jsonObject))
        listOf("rowAsked,", "RunSettings.lineInSentence(settings.line),", "\"\\(RunSettings.automatic) \\(settings.automatic ? \"on\" : \"off\")\",",
            "\"at most \\(settings.maxConcurrentTasks) at a time\",", "].joined(separator: \" · \")",
            "line == .main ? \"directly into main\" : \"a project branch\"").forEach { assertTrue("ProjectRunSettings.swift no longer says $it", page.contains(it)) }
        assertEquals("Tasks land on: decided when you start", RunSettings.undecidedLine(null))
        assertEquals("Tasks land on: decided when you start — the coordinator suggests a project branch", RunSettings.undecidedLine("PROJECT_BRANCH"))
        assertTrue(page.contains("\"\\(tasksLandOn): \\(lineDecidedAtStart)\""))
        assertTrue(page.contains("\"\\(decided) — \\(lineSuggested) \\(lineInSentence(suggested))\""))
    }

    /** The owner's own Start… is set by the default rule and is a card nobody asked for (`OwnerStartProjectSheet`). */
    @Test fun theOwnersStartIsSetByTheDefaultRule() {
        listOf("let line = decided ?? (graph.map(planHasDependencies) == true ? .projectBranch : .main)", "automatic: true,",
            "maxConcurrentTasks: maxConcurrentTasks ?? 1,", "mergeCheckCommand: view?.mergeCheckCommand)",
            "ProjectStartRequest(settings: settings, why: \"\", criteriaDigest: criteriaDigest)").forEach {
            assertTrue("ProjectRunSettings.swift no longer says $it", page.contains(it))
        }
    }
}
