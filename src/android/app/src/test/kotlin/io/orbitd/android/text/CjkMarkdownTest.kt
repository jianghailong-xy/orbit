package io.orbitd.android.text

import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same inputs as the web `cjkMarkdown.test.ts` and OrbitKit's `MarkdownTests`, so the three read one rule. */
class CjkMarkdownTest {
    private class Read(var bold: Int = 0, var text: String = "", val links: MutableList<String> = mutableListOf())

    private fun read(markdown: String): Read {
        val read = Read()
        fun walk(node: Node) {
            if (node is StrongEmphasis) read.bold += 1
            if (node is Link) read.links += node.destination
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
            assertEquals(mended, mendCjkMarkdown(markdown))
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
        ).forEach { assertEquals(it, mendCjkMarkdown(it)) }
    }

    @Test fun endsABareUrlWhereTheAddressEnds() {
        listOf(
            Triple("打开 https://orbitd.io，也就是你的账号。", "打开 <https://orbitd.io>，也就是你的账号。", "https://orbitd.io"),
            Triple("地址 **http://217.216.108.220:2087**（IPv4 明文", "地址 **<http://217.216.108.220:2087>**（IPv4 明文", "http://217.216.108.220:2087"),
            Triple("**http://192.168.1.12:8765/**，点“下载”", "**<http://192.168.1.12:8765/>**，点“下载”", "http://192.168.1.12:8765/"),
            Triple("http://localhost:2376看看", "<http://localhost:2376>看看", "http://localhost:2376"),
            Triple("https://a.com/docs查看说明", "<https://a.com/docs>查看说明", "https://a.com/docs"),
            Triple("https://zh.wikipedia.org/wiki/中文，然后", "<https://zh.wikipedia.org/wiki/中文>，然后", "https://zh.wikipedia.org/wiki/中文"),
            Triple("https://zh.wikipedia.org/wiki/中文_语言。", "<https://zh.wikipedia.org/wiki/中文_语言>。", "https://zh.wikipedia.org/wiki/中文_语言"),
            Triple("(see http://a.com)，然后", "(see <http://a.com>)，然后", "http://a.com"),
            Triple("http://a.com/x_(y)，然后", "<http://a.com/x_(y)>，然后", "http://a.com/x_(y)"),
            Triple("http://a.com.，然后", "<http://a.com>.，然后", "http://a.com"),
            Triple("“http://a.com”是地址", "“<http://a.com>”是地址", "http://a.com"),
            Triple("地址http://a.com，然后", "地址<http://a.com>，然后", "http://a.com"),
            Triple("http://a.com?x=1&y=2，然后", "<http://a.com?x=1&y=2>，然后", "http://a.com?x=1&y=2"),
            Triple("**看 http://a.com：**然后", "**看 <http://a.com>**：然后", "http://a.com"),
            Triple("http://a.com/**/b，然后**做法：**照", "<http://a.com/**/b>，然后**做法**：照", "http://a.com/**/b"),
        ).forEach { (markdown, mended, link) ->
            assertEquals(mended, mendCjkMarkdown(markdown))
            assertEquals("the parser's link in $mended", listOf(link), read(mended).links)
        }
    }

    @Test fun leavesAloneWhatIsNotABareUrlToEnd() {
        listOf(
            "plain http://a.com/x then words", // one that stops at a space
            "https://zh.wikipedia.org/wiki/中文 是页面", // a path segment that opens on CJK
            "xhttp://a.com，然后", // a scheme inside a word
            "http://，然后", // no address
            "http://**，然后", // no address, only marks
            "`http://a.com，然后`", // a code span
            "[链接](http://a.com/路径，然后)", // a link's address
            "[http://a.com，然后](http://a.com)", // a link's text
            "![图](http://a.com/图，一)", // an image's address
            "<http://a.com，然后>", // an autolink
            "[ref]: http://a.com/路径，然后", // a reference definition
            "```\nhttp://a.com，然后\n```", // a fenced block
        ).forEach { assertEquals(it, mendCjkMarkdown(it)) }
    }
}
