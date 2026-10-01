import XCTest
@testable import OrbitKit

final class UnifiedDiffTests: XCTestCase {
    /// A merge recovery's complete candidate diff is one `git diff`; the review sheet lists it by
    /// file, each with the same status letter and `+/−` the branch bar's diff list draws.
    func testSplitsAPatchIntoItsFiles() {
        let patch = """
        diff --git a/src/a.ts b/src/a.ts
        index 1111111..2222222 100644
        --- a/src/a.ts
        +++ b/src/a.ts
        @@ -1,3 +1,3 @@
         keep
        -old
        +new
        --- a removed line that happens to start with two dashes
        diff --git a/new.txt b/new.txt
        new file mode 100644
        index 0000000..3333333
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1,2 @@
        +one
        +two
        diff --git a/gone.txt b/gone.txt
        deleted file mode 100644
        index 4444444..0000000
        --- a/gone.txt
        +++ /dev/null
        @@ -1 +0,0 @@
        -bye
        diff --git a/old name.txt b/new name.txt
        similarity index 90%
        rename from old name.txt
        rename to new name.txt
        diff --git a/logo.png b/logo.png
        index 5555555..6666666 100644
        Binary files a/logo.png and b/logo.png differ

        """
        let files = UnifiedDiff.files(patch)
        XCTAssertEqual(files.map(\.path), ["src/a.ts", "new.txt", "gone.txt", "new name.txt", "logo.png"])
        XCTAssertEqual(files.map(\.status), ["M", "A", "D", "R", "M"])
        XCTAssertEqual(files.map(\.additions), [1, 2, 0, 0, -1], "binary is -1, as the bar's list reads it")
        XCTAssertEqual(files.map(\.deletions), [2, 0, 1, 0, -1],
                       "a removed line starting with `--` is content, not a file header")
        XCTAssertTrue(files[1].patch.hasPrefix("diff --git a/new.txt b/new.txt\nnew file mode"))
        XCTAssertTrue(files[1].patch.hasSuffix("+two"), "each file's text stops where the next file starts")
    }

    func testNothingToListWithoutGitHeaders() {
        XCTAssertEqual(UnifiedDiff.files(""), [])
        XCTAssertEqual(UnifiedDiff.files("@@ -1 +1 @@\n-a\n+b"), [])
    }
}
