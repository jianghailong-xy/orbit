package io.orbitd.android.text

import org.commonmark.node.Node
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same inputs as the web `cjkBold.test.ts` and OrbitKit's `MarkdownTests`, so the three read one rule. */
class CjkBoldTest {
    private class Read(var bold: Int = 0, var text: String = "")

    private fun read(markdown: String): Read {
        val read = Read()
        fun walk(node: Node) {
            if (node is StrongEmphasis) read.bold += 1
            if (node is Text) read.text += node.literal
            node.children().forEach(::walk)
        }
        walk(markdownParser.parse(markdown))
        return read
    }

    @Test fun movesTheMarkThatKeepsTheStarsDrawn() {
        listOf(
            "**做法：**照上个项目的办法" to "**做法**：照上个项目的办法",
            "这是**“重点”**内容" to "这是“**重点**”内容",
            "**注意：**run this" to "**注意**：run this",
            "**note:**中文" to "**note**:中文",
            "- **跑哪一版？**我的建议" to "- **跑哪一版**？我的建议",
            "**做法（注意）：**照" to "**做法（注意）**：照",
            "**运行 `npm test`：**然后" to "**运行 `npm test`**：然后",
            "**好**的：**做法：**照" to "**好**的：**做法**：照",
            "**涨幅 10%**以上" to "**涨幅 10**%以上",
            "用**C++**写" to "用**C+**+写",
            "这是**✅完成**内容" to "这是✅**完成**内容",
            "**a *b*：**c" to "**a *b***：c",
            "**[做法](orbit-task:34q)：**照" to "**[做法](orbit-task:34q)**：照",
            "**[`a*b`](u)：**照" to "**[`a*b`](u)**：照",
            "```\ncode\n```\n**做法：**照" to "```\ncode\n```\n**做法**：照",
            "**做法：**照\r\n**注意：**看" to "**做法**：照\r\n**注意**：看",
        ).forEach { (markdown, mended) ->
            assertEquals(mended, mendCjkBold(markdown))
            // The parser's own reading, before and after: the same words, now bold and with no stars.
            val before = read(markdown)
            val after = read(mended)
            assertTrue("the parser draws the stars of $markdown", before.text.contains("**"))
            assertFalse("no stars are left in $mended", after.text.contains("**"))
            assertTrue("$mended is bold", after.bold > before.bold)
            assertEquals(before.text.replace("**", ""), after.text)
        }
    }

    @Test fun leavesAloneWhatIsNotThisMisfire() {
        listOf(
            "**note:**word", // no CJK at the marks
            "a**-1 和 b**2", // a power
            "值**-1 和 b**2", // a power beside CJK
            "src/tasks/**和 lib/**目录", // paths
            "目录**/b 和 c**/d", // a path beside CJK
            "目录**.ts 和 lib/**.js", // a glob on a file name
            "**做法：** 照", // already flanking, a space outside
            "**做法：**，照", // already flanking, punctuation outside
            "**做法：**", // already flanking, the end of the line
            "**做法**：照", // already flanking, no mark inside
            "`**做法：**照`", // a code span
            "**[做法](https://a.com)**照", // a link
            "**![图](a.png)**照", // an image
            "这是**![图](a.png)**照", // an image after CJK
            "**[做法][ref]**照", // a reference link
            "这是**![图][ref]**照", // a reference image after CJK
            "<https://a.com/**做法：**照>", // stars in an autolink's address
            "**做法[^1]**后面", // a footnote
            "**看 <https://a.com>**照", // an autolink
            "**a&amp;**照", // an entity
            "**做法\\:**照", // an escaped mark
            "**做法\\**照", // an escaped backslash, not its star
            "**做法：**`x`", // already flanking, code outside
            "**做法：**[链接](u)", // already flanking, a link outside
            "\\*\\*做法：\\*\\*照", // escaped stars
            "\\**做法：**照", // an escaped star
            "***做法：**照", // three stars opening
            "** BUILD SUCCEEDED **，然后", // stars with spaces inside
            "这是**「 重点**内容", // a space would take the mark's place
            "***做法：***照", // bold and italic
            "**：**照", // nothing left to be bold
            "没有星号：这里", // no stars
            "```\n**做法：**照\n```", // a fenced block
            "~~~\n**做法：**照\n~~~", // a tilde fence
            "> ```\n> **做法：**照\n> ```", // a fence in a quote
            "```\n**做法：**照", // a fence cut off
        ).forEach { assertEquals(it, mendCjkBold(it)) }
    }
}
