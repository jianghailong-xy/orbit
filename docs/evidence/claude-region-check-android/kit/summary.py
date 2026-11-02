"""summary.py <dir>: totals per report directory, then every test of the A11k classes and every failure, from JUnit XML."""
import sys, pathlib, xml.etree.ElementTree as ET
root = pathlib.Path(sys.argv[1])
watch = ("ClaudeRegionTest", "ClaudeRegionCopyParityTest", "SessionRunStartTest", "RunnerPageTest")
for task in sorted(p for p in root.iterdir() if p.is_dir()):
    total = failed = skipped = 0
    rows = []
    for xml in sorted(task.glob("*.xml")):
        for case in ET.parse(xml).getroot().iter("testcase"):
            total += 1
            cls, name, secs = case.get("classname", ""), case.get("name", ""), case.get("time", "")
            bad = case.find("failure") if case.find("failure") is not None else case.find("error")
            if case.find("skipped") is not None: skipped += 1
            if bad is not None:
                failed += 1
                first = (bad.get("message") or bad.text or "").strip().splitlines()
                rows.append(f"  FAIL {cls}.{name} ({secs}s): {first[0][:300] if first else ''}")
            elif cls.endswith(watch):
                rows.append(f"  pass {cls}.{name} ({secs}s)")
    print(f"{task.name}: {total} tests, {failed} failed, {skipped} skipped")
    print("\n".join(rows))
