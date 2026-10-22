package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * A07-25: shared cursorModels.ts's own cases (`src/shared/src/cursor-model-variants.spec.ts`), run against CursorRuntime and
 * ComposerCatalog in place of encodeCursorModel, decodeCursorModel, runnerCatalogRow and fastModeAvailable. The spec is read, not copied:
 * [SpecReader] evaluates its consts, loops and `expect(…)` statements, and every `expect` in it has to run — so a case added there runs
 * here, and one written in a way the reader can't follow reds rather than being skipped. The rules the cases stand for are read off
 * cursorModels.ts itself, as OrbitKit CursorRuntimeTests reads them. A missing source fails, never skips.
 */
class CursorModelVariantsSpecTest {
    private fun shared(file: String): String {
        val found = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.map { File(it, "src/shared/src/$file") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/$file was not found above the test's working directory", found)
        return found!!.readText()
    }

    /** The spec's object literals as the JSON CursorRuntime reads, and back. */
    private fun json(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Int -> JsonPrimitive(value)
        is List<*> -> JsonArray(value.map(::json))
        is Map<*, *> -> JsonObject(value.filterValues { it != SpecReader.Undefined }.entries.associate { (k, v) -> k as String to json(v) })
        else -> error("no JSON for $value")
    }
    private fun plain(element: JsonElement): Any? = when (element) {
        is JsonNull -> null
        is JsonObject -> element.mapValues { plain(it.value) }
        is JsonArray -> element.map(::plain)
        is JsonPrimitive -> if (element.isString) element.content else element.booleanOrNull ?: element.intOrNull ?: element.content
    }
    private fun catalogOf(catalog: Any?) = ComposerCatalog(buildJsonObject { put("modelCatalog", json(catalog)) }, emptyList())
    /** A settings argument: a string each, or none for null and undefined. */
    private fun settings(value: Any?): Map<String, String?> = (value as? Map<*, *>).orEmpty().entries.associate { (id, setting) ->
        id as String to when (setting) { null, SpecReader.Undefined -> null; is String -> setting; else -> error("a setting is a string: $setting") }
    }

    private val names: Map<String, Any?> = mapOf(
        "CURSOR_AUTO_MODEL" to CursorRuntime.AUTO_MODEL,
        "CURSOR_VARIANT_PARAMETERS" to CursorRuntime.VARIANT_PARAMETERS,
        "AgentProvider" to ProviderEngines.ALL_ENGINES.associateBy { it.uppercase() },
        "decodeCursorModel" to SpecReader.Function { args ->
            CursorRuntime.decodeModel(args.single() as String?).let { mapOf("model" to it.model, "parameters" to it.parameters) }
        },
        "encodeCursorModel" to SpecReader.Function { args ->
            CursorRuntime.encodeModel(args[0] as String, settings(args.getOrNull(1)), args.getOrNull(2)?.let { json(it) as JsonObject })
        },
        "runnerCatalogRow" to SpecReader.Function { (engine, model, catalog) ->
            catalogOf(catalog).modelRow(engine as String, engine, model as String)?.let(::plain) ?: SpecReader.Undefined
        },
        "fastModeAvailable" to SpecReader.Function { (engine, model, catalog) -> catalogOf(catalog).fast(engine as String, engine, model as String) },
    )

    @Test fun theSharedSpecsCasesHoldHere() {
        val reader = SpecReader(shared("cursor-model-variants.spec.ts"), names)
        reader.run()
        assertTrue("the spec states cases", reader.stated.isNotEmpty())
        assertEquals("every expect in the spec ran", reader.stated, reader.ran)
    }

    /** What the cases stand for, in cursorModels.ts's own words: its Auto, its settings, a pair's syntax, a strict read, the order of
     * the ids. */
    @Test fun theRulesAreCursorModelsTsOwn() {
        val source = shared("cursorModels.ts")
        assertTrue(source.contains("export const CURSOR_AUTO_MODEL = '${CursorRuntime.AUTO_MODEL}';"))
        assertTrue(source.contains("export const CURSOR_VARIANT_PARAMETERS = [${CursorRuntime.VARIANT_PARAMETERS.joinToString(", ") { "'$it'" }}] as const;"))
        // A side of a pair holds no whitespace, '=', ',', '[' or ']', and is not empty: CursorRuntime's `plain`.
        assertTrue(source.contains("""const PAIR = /^([^\s=,[\]]+)=([^\s=,[\]]+)${'$'}/;"""))
        assertTrue(source.contains("if (open <= 0 || !text.endsWith(']') || text.indexOf(']') !== text.length - 1 || text.lastIndexOf('[') !== open) {"))
        assertTrue(source.contains("if (!match || match[1] in parameters) return asIs;"))
        assertTrue(source.contains("if (!name || name === CURSOR_AUTO_MODEL) return name;"))
        assertTrue(source.contains(".sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));"))
    }
}

/**
 * Reads the plain TypeScript a shared spec is written in, and runs it: imports (skipped), `const` with or without a type, `describe` and
 * `it` with an arrow's body, `for (const x of …)`, and `expect(actual[, message]).toBe/toEqual/toBeUndefined(…)` — over strings, numbers,
 * null, undefined, booleans, object and array literals, [names], `.name`, `[i]`, `!` and calls to the [Function]s among them. `toBe` is
 * equality here, as `toEqual` is. Anything else fails, saying where.
 */
internal class SpecReader(private val source: String, private val names: Map<String, Any?>) {
    fun interface Function { fun call(args: List<Any?>): Any? }
    object Undefined { override fun toString() = "undefined" }

    private data class Token(val kind: Char, val text: String, val at: Int)
    private val tokens = tokenize()
    private var pos = 0
    /** The line of each `expect(` in the source, and of those that ran. */
    val stated = tokens.indices.filter { tokens[it].text == "expect" && tokens.getOrNull(it + 1)?.text == "(" }.map { line(tokens[it].at) }.toSet()
    val ran = mutableSetOf<Int>()

    private class Scope(val parent: Scope?) {
        val values = mutableMapOf<String, Any?>()
        fun lookup(name: String): Any? = when {
            values.containsKey(name) -> values[name]
            parent != null -> parent.lookup(name)
            else -> throw AssertionError("The spec names $name, which the reader was not given")
        }
    }

    fun run() {
        val top = Scope(null).also { it.values.putAll(names) }
        while (pos < tokens.size) statement(top)
    }

    private fun tokenize(): List<Token> {
        val out = mutableListOf<Token>()
        var i = 0
        while (i < source.length) {
            val c = source[i]
            when {
                c.isWhitespace() -> i++
                source.startsWith("//", i) -> i = source.indexOf('\n', i).let { if (it < 0) source.length else it }
                source.startsWith("/*", i) -> i = source.indexOf("*/", i + 2).also { check(it >= 0) { "unterminated comment" } } + 2
                c == '\'' || c == '"' || c == '`' -> {
                    val start = i++
                    val text = StringBuilder()
                    while (source[i] != c) {
                        if (source[i] == '\\') text.append(when (val escaped = source[++i]) { 'n' -> '\n'; 't' -> '\t'; 'r' -> '\r'; else -> escaped })
                        else text.append(source[i])
                        i++
                    }
                    i++
                    out += Token(if (c == '`') 't' else 's', text.toString(), start)
                }
                c.isDigit() -> { val start = i; while (i < source.length && source[i].isDigit()) i++; out += Token('n', source.substring(start, i), start) }
                c.isLetter() || c == '_' || c == '$' -> {
                    val start = i
                    while (i < source.length && (source[i].isLetterOrDigit() || source[i] == '_' || source[i] == '$')) i++
                    out += Token('i', source.substring(start, i), start)
                }
                else -> {
                    val punctuation = listOf("=>", "...", "===", "!==", "?.").firstOrNull { source.startsWith(it, i) } ?: c.toString()
                    out += Token('p', punctuation, i); i += punctuation.length
                }
            }
        }
        return out
    }

    private fun line(at: Int) = source.substring(0, at).count { it == '\n' } + 1
    private fun where() = tokens.getOrNull(pos)?.let { "line ${line(it.at)}, “${it.text}”" } ?: "the end"
    private fun fail(what: String): Nothing = throw AssertionError("The spec reader can't read $what at ${where()}")
    private fun peek(text: String) = tokens.getOrNull(pos)?.let { it.text == text && (it.kind == 'p' || it.kind == 'i') } == true
    private fun take(text: String) { if (!peek(text)) fail("“$text”"); pos++ }
    private fun name(): String = tokens.getOrNull(pos)?.takeIf { it.kind == 'i' }?.also { pos++ }?.text ?: fail("a name")
    private fun string(scope: Scope) = value(scope) as? String ?: fail("a title")
    /** Passes over what the reader has no use for — an import, a type — up to [text], which it leaves. */
    private fun skipTo(text: String) { while (!peek(text)) if (++pos >= tokens.size) fail("“$text”") }

    private fun statement(scope: Scope) {
        when {
            peek("import") -> { skipTo(";"); pos++ }
            peek("const") -> {
                pos++
                val name = name()
                if (peek(":")) skipTo("=")
                take("=")
                scope.values[name] = value(scope)
                if (peek(";")) pos++
            }
            peek("describe") || peek("it") -> {
                pos++; take("("); string(scope); take(","); take("("); take(")"); take("=>"); take("{")
                block(Scope(scope))
                take(")"); if (peek(";")) pos++
            }
            peek("for") -> {
                pos++; take("("); take("const")
                val name = name()
                take("of")
                val items = value(scope) as? List<*> ?: fail("a list to loop over")
                if (items.isEmpty()) fail("a loop over nothing")
                take(")"); take("{")
                val body = pos
                items.forEach { item -> pos = body; block(Scope(scope).also { it.values[name] = item }) }
            }
            peek("expect") -> expectation(scope)
            else -> fail("the statement")
        }
    }

    /** The statements up to the closing brace, which it takes. */
    private fun block(scope: Scope) {
        while (!peek("}")) statement(scope)
        pos++
    }

    private fun expectation(scope: Scope) {
        val at = line(tokens[pos].at)
        pos++; take("(")
        val actual = value(scope)
        val message = if (peek(",")) { pos++; value(scope).toString() } else null
        take(")"); take(".")
        val matcher = name()
        take("(")
        val expected = if (peek(")")) Undefined else value(scope)
        if (peek(",")) pos++
        take(")"); if (peek(";")) pos++
        val label = "the spec's expect on line $at" + (message?.let { ", $it" } ?: "")
        when (matcher) {
            "toBe", "toEqual" -> assertEquals(label, expected, actual)
            "toBeUndefined" -> assertEquals(label, Undefined, actual)
            else -> fail("the matcher $matcher")
        }
        ran += at
    }

    private fun value(scope: Scope): Any? {
        var value = primary(scope)
        while (true) value = when {
            peek(".") -> {
                pos++
                val member = name()
                val fields = value as? Map<*, *> ?: fail(".$member")
                if (fields.containsKey(member)) fields[member] else Undefined
            }
            peek("!") -> { pos++; value }
            peek("[") -> {
                pos++
                val index = value(scope) as? Int ?: fail("an index")
                take("]")
                val list = value as? List<*> ?: fail("[$index]")
                if (index < list.size) list[index] else Undefined
            }
            peek("(") -> { pos++; val args = items(scope, ")"); (value as? Function ?: fail("a call")).call(args) }
            else -> return value
        }
    }

    private fun primary(scope: Scope): Any? {
        val token = tokens.getOrNull(pos) ?: fail("a value")
        pos++
        return when {
            token.kind == 's' -> token.text
            token.kind == 'n' -> token.text.toInt()
            token.kind == 'i' -> when (token.text) {
                "null" -> null; "undefined" -> Undefined; "true" -> true; "false" -> false
                else -> scope.lookup(token.text)
            }
            token.text == "{" -> {
                val entries = linkedMapOf<String, Any?>()
                while (!peek("}")) {
                    val key = tokens.getOrNull(pos)?.takeIf { it.kind == 's' || it.kind == 'i' }?.text ?: fail("a key")
                    pos++; take(":")
                    entries[key] = value(scope)
                    if (!peek("}")) take(",")
                }
                pos++
                entries
            }
            token.text == "[" -> items(scope, "]")
            token.text == "(" -> value(scope).also { take(")") }
            else -> { pos--; fail("a value") }
        }
    }

    /** Values up to [close], which it takes; a trailing comma is allowed, as the spec's formatter writes one. */
    private fun items(scope: Scope, close: String): List<Any?> {
        val out = mutableListOf<Any?>()
        while (!peek(close)) {
            out += value(scope)
            if (!peek(close)) take(",")
        }
        pos++
        return out
    }
}
