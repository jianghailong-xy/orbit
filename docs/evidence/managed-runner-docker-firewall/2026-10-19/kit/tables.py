#!/usr/bin/env python3
"""D9: the probes of one scenario as a Markdown table, one column per probe label (its order in probes.jsonl).
    tables.py <scenario dir> [label ...]"""
import json
import sys
from pathlib import Path

SHORT = {"CONNECTED": "connected", "ECHOED": "echoed", "EHOSTUNREACH": "**refused (firewall)**", "ECONNREFUSED": "refused (target)",
         "TIMEOUT": "timeout"}


def cell(result):
    if result.startswith("RESOLVED"):
        return "resolved"
    if result.startswith("HTTP "):
        return result
    return SHORT.get(result, result)


def main():
    folder, wanted = Path(sys.argv[1]), sys.argv[2:]
    probes = [json.loads(line) for line in (folder / "probes.jsonl").read_text().splitlines()]
    if wanted:
        probes = [p for label in wanted for p in probes if p["label"] == label]
    names = [r["name"] for r in probes[0]["results"]]
    print("| From the runner container | " + " | ".join(f"`{p['label']}`" for p in probes) + " |")
    print("| --- | " + " | ".join("---" for _ in probes) + " |")
    for name in names:
        row = [cell(next(r["result"] for r in p["results"] if r["name"] == name)) for p in probes]
        print(f"| {name} | " + " | ".join(row) + " |")


if __name__ == "__main__":
    main()
