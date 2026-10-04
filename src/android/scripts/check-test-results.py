#!/usr/bin/env python3
"""Reject empty, skipped, or failing local-test runs in either Android module."""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main():
    android_dir = Path(sys.argv[1])
    total = 0
    for module, task in (
        ("core", "test"),
        ("app", "testDebugUnitTest"),
        ("app", "testReleaseUnitTest"),
    ):
        reports = sorted((android_dir / module / "build/test-results" / task).glob("TEST-*.xml"))
        if not reports:
            raise ValueError(f":{module}:{task}: no JUnit XML reports")
        count = 0
        for report in reports:
            suite = ET.parse(report).getroot()
            cases = suite.findall("testcase")
            if int(suite.attrib["tests"]) != len(cases):
                raise ValueError(f"{report}: test count does not match recorded cases")
            if any(int(suite.attrib.get(key, 0)) for key in ("failures", "errors", "skipped")):
                raise ValueError(f"{report}: failed, errored, or skipped tests")
            if any(case.find(tag) is not None for case in cases for tag in ("failure", "error", "skipped")):
                raise ValueError(f"{report}: failed, errored, or skipped test case")
            count += len(cases)
        if count == 0:
            raise ValueError(f":{module}:{task}: zero tests executed")
        print(f":{module}:{task}: tests={count}, failures=0, errors=0, skipped=0")
        total += count
    print(f"Total: {total} local tests passed; no skips")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, ET.ParseError) as error:
        sys.exit(str(error))
