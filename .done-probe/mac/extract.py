#!/usr/bin/env python3
"""TEMPORARY evidence probe (see ../README.md).

Cut the shared card language out of the app's real sources, so the probe draws the cards with the
very chrome the app draws them in: `ApprovalCards.swift` from its "shared card language" mark to the
first card-specific helper, `ApprovalReview.swift` up to the sheet that needs a ConsoleModel, and
`ProjectsView.swift`'s list row with the palette and meter it draws.

usage: extract.py <OrbitApp sources dir> <out dir>
"""
import sys
from pathlib import Path

app, out = Path(sys.argv[1]), Path(sys.argv[2])
cards = (app / "Views/ApprovalCards.swift").read_text()
start = cards.index("// MARK: - shared card language")
end = cards.index("/// Answer an approval.")
(out / "CardLanguage.swift").write_text("import SwiftUI\nimport OrbitKit\n\n" + cards[start:end])
review = (app / "Views/ApprovalReview.swift").read_text()
cut = review.index("/// Presented by ConsoleView")
(out / "ReviewLayout.swift").write_text(review[:cut])
projects = (app / "Views/ProjectsView.swift").read_text()
a = projects.index("enum ProjectPalette {")
b = projects.index("struct ProjectsListView: View {")
c = projects.index("struct ProjectRow: View {")
d = projects.index("/// What stands where the rows would be.")
landing = (app / "Views/ProjectLandingRow.swift").read_text()
e = landing.index("struct ProjectSpinnerRing: View {")
f = landing.index("/// The row's ring:")
(out / "ListRow.swift").write_text("import SwiftUI\nimport OrbitKit\n\n" + projects[a:b] + projects[c:d]
                                   + landing[e:f])
print("==> extracted CardLanguage.swift (%d chars), ReviewLayout.swift (%d chars), ListRow.swift (%d chars)"
      % (end - start, cut, (b - a) + (d - c)))
