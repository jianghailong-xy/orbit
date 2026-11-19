package io.orbitd.android.projects

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier

/** The done card's follow-up words are the web's: every String constant of [DoneCopy] is the named constant of the same name in
 * src/web/src/lib/projectDone.ts (or projectStart.ts), byte for byte — so web, Android and the native clients that hold to the same
 * file render one copy (project criterion 6). OrbitKit gains these words in its own task; the Swift parity tests then hold them. */
class DoneCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/projectDone.ts").isFile }
    private val web = listOf("projectDone.ts", "projectStart.ts").joinToString("\n") { File(root, "src/web/src/lib/$it").readText() }
    private val words = DoneCopy::class.java.declaredFields
        .filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }
        .associate { it.isAccessible = true; it.name to it.get(null) as String }

    @Test fun everyWordIsTheWebsNamedConstant() {
        assertTrue("DoneCopy has no words", words.size > 100)
        val missing = words.filter { (name, value) -> !web.contains("export const $name = '$value';") }
        assertTrue("DoneCopy words that are not the web's constant of the same name: $missing", missing.isEmpty())
    }

    /** Every constant the web's follow-up block names is here too, except the web's own anchor and its drag-and-drop line. */
    @Test fun noFollowUpWordIsLeftOut() {
        val block = File(root, "src/web/src/lib/projectDone.ts").readText().let {
            it.substring(it.indexOf("// The non-code mark (decided board"), it.indexOf("/** The authenticated owner status door"))
        }
        val named = Regex("""export const (\w+) = '""").findAll(block).map { it.groupValues[1] }.toSet()
        val webOnly = setOf("NON_CODE_ANCHOR", "CONFIRM_SHEET_DROP")
        assertEquals(emptySet<String>(), named - webOnly - words.keys)
    }

    /** The words the cards compose from them read as the web's helpers do. */
    @Test fun composedWordsMatchTheWebsHelpers() {
        assertTrue(web.contains("NO_BRANCH: LANDING_RAN_WITHOUT_BRANCH.toLowerCase()"))
        assertEquals("ran without a branch", ProjectDone.reasonLabel("NO_BRANCH"))
        assertEquals("no code to land", ProjectDone.reasonLabel("CODELESS"))
        assertEquals(DoneCopy.LANDING_RAN_WITHOUT_BRANCH, ProjectDone.landingReasonLabel("NO_BRANCH"))
        assertEquals(DoneCopy.LANDING_NO_CODE_TO_LAND, ProjectDone.landingReasonLabel("CODELESS"))
        assertTrue(web.contains("export const DONE_CHECK_UNLANDED = '${ProjectDone.checkUnlanded}';"))
        assertTrue(web.contains("export const DONE_CARD_FINDINGS_HEADING = '${ProjectDone.findingsHeading}';"))
    }
}
