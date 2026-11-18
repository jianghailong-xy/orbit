#!/usr/bin/env python3
"""Generate core/.../schedule/ScheduleCopy.kt from contracts/schedule.contract.json `copy`.

The Kotlin twin of OrbitKit's ScheduleCopy.swift: the same member names, and `contract` flattening every sentence to
its contract path. ScheduleCopyParityTest holds the output to the contract, so run this after changing the contract:

    python3 src/android/scripts/gen-schedule-copy.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
CONTRACT = ROOT / "contracts" / "schedule.contract.json"
OUT = ROOT / "src/android/core/src/main/kotlin/io/orbitd/android/core/schedule/ScheduleCopy.kt"

# Top-level groups read as a map keyed by a closed-set member (Swift `[String: String]`).
TOP_MAPS = {"groups", "weekdays", "weekdaysPlural", "weekdaysShort", "runStates", "failureReasons", "runReasonTexts",
            "failureReasonsWithSummary", "heldShort", "endedReasons", "keep"}
# Groups nested in an object that stay a map.
INNER_MAPS = {"history.who", "history.fields", "envelopeCard.titles"}
KEYWORDS = {"as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is",
            "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof",
            "val", "var", "when", "while"}


def lit(text: str) -> str:
    out = text.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("\n", "\\n")
    return f'"{out}"'


def name(key: str) -> str:
    return f"`{key}`" if key in KEYWORDS else key


def cap(key: str) -> str:
    return key[0].upper() + key[1:]


def string_map(entries: dict, indent: str) -> str:
    rows = "".join(f"{indent}    {lit(k)} to {lit(v)},\n" for k, v in entries.items())
    return f"mapOf(\n{rows}{indent})"


def main() -> None:
    copy = json.loads(CONTRACT.read_text(encoding="utf-8"))["copy"]
    body: list[str] = []
    paths: list[tuple[str, str]] = []  # (contract path, Kotlin expression)

    for group, value in copy.items():
        if isinstance(value, str):
            body.append(f"    const val {name(group)} = {lit(value)}")
            paths.append((group, name(group)))
        elif isinstance(value, list):
            items = ", ".join(lit(v) for v in value)
            body.append(f"    val {name(group)}: List<String> = listOf({items})")
            paths += [(f"{group}.{i}", f"{name(group)}[{i}]") for i in range(len(value))]
        elif group == "access":
            rows = "".join(f"        {lit(k)} to ScheduleAccessCopy({lit(v['label'])}, {lit(v['detail'])}, {lit(v['brief'])}),\n"
                           for k, v in value.items())
            body.append(f"    val access: Map<String, ScheduleAccessCopy> = mapOf(\n{rows}    )")
            for k in value:
                paths += [(f"access.{k}.{f}", f"access.getValue({lit(k)}).{f}") for f in ("label", "detail", "brief")]
        elif group == "heldReasons":
            rows = "".join(f"        {lit(k)} to ScheduleHeldCopy({lit(v['clause'])}, {lit(v['until'])}),\n"
                           for k, v in value.items())
            body.append(f"    val heldReasons: Map<String, ScheduleHeldCopy> = mapOf(\n{rows}    )")
            for k in value:
                paths += [(f"heldReasons.{k}.{f}", f"heldReasons.getValue({lit(k)}).{f}") for f in ("clause", "until")]
        elif group in TOP_MAPS:
            body.append(f"    val {name(group)}: Map<String, String> = {string_map(value, '    ')}")
            paths += [(f"{group}.{k}", f"{name(group)}.getValue({lit(k)})") for k in value]
        else:
            obj = cap(group)
            members: list[str] = []

            def walk(node: dict, prefix: str, path: str) -> None:
                for key, v in node.items():
                    member = key if not prefix else prefix + cap(key)
                    full = f"{path}.{key}"
                    if isinstance(v, str):
                        members.append(f"        const val {name(member)} = {lit(v)}")
                        paths.append((full, f"{obj}.{name(member)}"))
                    elif isinstance(v, list):
                        items = ", ".join(lit(x) for x in v)
                        members.append(f"        val {name(member)}: List<String> = listOf({items})")
                        paths.extend((f"{full}.{i}", f"{obj}.{name(member)}[{i}]") for i in range(len(v)))
                    elif full in INNER_MAPS:
                        members.append(f"        val {name(member)}: Map<String, String> = {string_map(v, '        ')}")
                        paths.extend((f"{full}.{k}", f"{obj}.{name(member)}.getValue({lit(k)})") for k in v)
                    else:
                        walk(v, member, full)

            walk(value, "", group)
            body.append(f"    object {obj} {{\n" + "\n".join(members) + "\n    }")

    contract_rows = "".join(f"        {lit(p)} to {e},\n" for p, e in paths)
    text = f"""package io.orbitd.android.core.schedule

// GENERATED from contracts/schedule.contract.json `copy` by src/android/scripts/gen-schedule-copy.py, and held to it
// word for word by ScheduleCopyParityTest: change the contract, then regenerate this file, never this file alone.
// The same words and member names as OrbitKit's ScheduleCopy.swift. Placeholders are `{{name}}`, filled by
// `ScheduleDisplay.fill`.

/** One access level's words: its label, the create card's May detail, and the envelope card's brief Now. */
data class ScheduleAccessCopy(val label: String, val detail: String, val brief: String)

/** Why a schedule is held, as a clause, and what has to change before Resume. */
data class ScheduleHeldCopy(val clause: String, val until: String)

/** Every word the Scheduled page, its inspector, the cards and Waiting on you put on screen. */
object ScheduleCopy {{
{chr(10).join(body)}

    /** Every sentence above under its contract path (`group.key`, arrays by index): what the parity test reads. */
    val contract: Map<String, String> by lazy {{
        mapOf(
{contract_rows}        )
    }}
}}
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(paths)} sentences)")


if __name__ == "__main__":
    main()
