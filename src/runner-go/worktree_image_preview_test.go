package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writePicture writes a w × h picture, a horizontal gradient, in the format its extension names;
// translucent makes its right half see-through.
func writePicture(t *testing.T, path string, w, h int, translucent bool) {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if translucent && x >= w/2 {
				a = 0
			}
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / w), G: 120, B: uint8(y * 255 / h), A: a})
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	var err error
	switch filepath.Ext(path) {
	case ".png":
		err = png.Encode(&buf, img)
	case ".jpg", ".jpeg":
		err = jpeg.Encode(&buf, img, nil)
	case ".gif":
		err = gif.Encode(&buf, img, nil)
	default:
		buf.WriteString("not a picture")
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func binaryFile(path, status string) ChangedFile {
	return ChangedFile{Path: path, Additions: -1, Deletions: -1, Status: status}
}

// decodePreview decodes a placeholder's data URL, failing the test unless it is mime.
func decodePreview(t *testing.T, p FilePatch, mime string) image.Image {
	t.Helper()
	prefix := "data:" + mime + ";base64,"
	if !strings.HasPrefix(p.Preview, prefix) {
		t.Fatalf("%s: placeholder is not a %s data URL: %.40q", p.Path, mime, p.Preview)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(p.Preview, prefix))
	if err != nil {
		t.Fatalf("%s: placeholder is not base64: %v", p.Path, err)
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("%s: placeholder does not decode: %v", p.Path, err)
	}
	return img
}

func resetImagePreviews(t *testing.T) {
	t.Helper()
	saved := imagePreviews
	imagePreviews = &imagePreviewCache{entries: map[imagePreviewKey]imagePreview{}}
	t.Cleanup(func() { imagePreviews = saved })
}

func previewsByPath(patches []FilePatch) map[string]FilePatch {
	out := map[string]FilePatch{}
	for _, p := range patches {
		out[p.Path] = p
	}
	return out
}

func TestImagePreviewsDrawEachChangedPicture(t *testing.T) {
	resetImagePreviews(t)
	dir := t.TempDir()
	writePicture(t, filepath.Join(dir, "docs/mocks/board.png"), 1720, 4565, false)
	writePicture(t, filepath.Join(dir, "shots/photo.jpg"), 640, 480, false)
	writePicture(t, filepath.Join(dir, "anim.gif"), 64, 32, false)
	writePicture(t, filepath.Join(dir, "icons/logo.png"), 192, 192, true)
	writePicture(t, filepath.Join(dir, "fonts/Inter.woff2"), 1, 1, false)
	writePicture(t, filepath.Join(dir, "broken.png"), 1, 1, false)
	if err := os.WriteFile(filepath.Join(dir, "broken.png"), []byte("not a png"), 0o644); err != nil {
		t.Fatal(err)
	}
	files := []ChangedFile{
		{Path: "README.md", Additions: 3, Deletions: 0, Status: "M"},
		binaryFile("docs/mocks/board.png", "A"),
		binaryFile("shots/photo.jpg", "M"),
		binaryFile("anim.gif", "A"),
		binaryFile("icons/logo.png", "A"),
		binaryFile("fonts/Inter.woff2", "A"),
		binaryFile("broken.png", "A"),
		binaryFile("old.png", "D"),
	}
	text := []FilePatch{{Path: "README.md", Patch: "@@ -1 +1 @@"}}

	got := withImagePreviews(dir, files, text)

	if len(got) != 5 || got[0].Path != "README.md" || got[0].Patch == "" {
		t.Fatalf("want the text patch then four placeholders, got %d entries: %+v", len(got), got)
	}
	by := previewsByPath(got)
	board := by["docs/mocks/board.png"]
	if board.Width != 1720 || board.Height != 4565 || board.Patch != "" {
		t.Fatalf("board entry carries the picture's own size and no patch text: %+v", board)
	}
	if b := decodePreview(t, board, "image/jpeg").Bounds(); b.Dx() != 96 || b.Dy() != 255 {
		t.Fatalf("a tall board shrinks to 96 wide at its own proportions, capped at 256: got %v", b.Size())
	}
	if b := decodePreview(t, by["shots/photo.jpg"], "image/jpeg").Bounds(); b.Dx() != 96 || b.Dy() != 72 {
		t.Fatalf("photo placeholder: %v", b.Size())
	}
	if b := decodePreview(t, by["anim.gif"], "image/jpeg").Bounds(); b.Dx() != 64 || b.Dy() != 32 {
		t.Fatalf("a picture narrower than the placeholder is never enlarged: %v", b.Size())
	}
	logo := decodePreview(t, by["icons/logo.png"], "image/png")
	if b := logo.Bounds(); b.Dx() != 48 || b.Dy() != 48 {
		t.Fatalf("a translucent picture's placeholder is a smaller PNG: %v", b.Size())
	}
	if _, _, _, a := logo.At(47, 24).RGBA(); a != 0 {
		t.Fatalf("the placeholder keeps the picture's transparency, alpha %d", a)
	}
	for _, path := range []string{"fonts/Inter.woff2", "broken.png", "old.png"} {
		if _, ok := by[path]; ok {
			t.Errorf("%s should have no placeholder", path)
		}
	}
	for _, p := range got[1:] {
		if len(p.Preview) > 6000 {
			t.Errorf("%s: placeholder of %d bytes is not tiny", p.Path, len(p.Preview))
		}
	}
}

func TestImagePreviewsDecodeEachVersionOnce(t *testing.T) {
	resetImagePreviews(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "board.png")
	writePicture(t, path, 400, 300, false)
	files := []ChangedFile{binaryFile("board.png", "A")}

	first := withImagePreviews(dir, files, nil)
	// Past the time budget a report starts no decode, but a version decoded before is still sent.
	saved := imagePreviewTimeBudget
	imagePreviewTimeBudget = 0
	t.Cleanup(func() { imagePreviewTimeBudget = saved })
	cached := withImagePreviews(dir, files, nil)
	if len(first) != 1 || len(cached) != 1 || cached[0].Preview != first[0].Preview {
		t.Fatalf("an unchanged picture is answered from the cache: %d, %d", len(first), len(cached))
	}

	// A new version of the file is decoded again, once the budget allows it.
	writePicture(t, path, 800, 300, false)
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if got := withImagePreviews(dir, files, nil); len(got) != 0 {
		t.Fatalf("past the budget a new version waits for a later report, got %+v", got)
	}
	imagePreviewTimeBudget = saved
	got := withImagePreviews(dir, files, nil)
	if len(got) != 1 || got[0].Width != 800 {
		t.Fatalf("the new version's placeholder: %+v", got)
	}
}

func TestImagePreviewsStayWithinTheirBounds(t *testing.T) {
	resetImagePreviews(t)
	dir := t.TempDir()
	for _, name := range []string{"a.png", "b.png", "c.png"} {
		writePicture(t, filepath.Join(dir, name), 300, 300, false)
	}
	writePicture(t, filepath.Join(dir, "huge.png"), 400, 400, false)
	files := []ChangedFile{binaryFile("a.png", "A"), binaryFile("b.png", "A"), binaryFile("c.png", "A"), binaryFile("huge.png", "A")}

	savedPixels, savedBytes := imagePreviewMaxPixels, imagePreviewReportBytes
	t.Cleanup(func() { imagePreviewMaxPixels, imagePreviewReportBytes = savedPixels, savedBytes })
	imagePreviewMaxPixels = 300 * 300
	one := withImagePreviews(dir, files[:1], nil)
	imagePreviewReportBytes = 2*len(one[0].Preview) + 10

	got := withImagePreviews(dir, files, nil)
	paths := []string{}
	for _, p := range got {
		paths = append(paths, p.Path)
	}
	if strings.Join(paths, ",") != "a.png,b.png" {
		t.Fatalf("a report stops at its byte cap and skips a picture over the pixel cap, got %v", paths)
	}
}

func TestImagePreviewsNeverLeaveTheWorktree(t *testing.T) {
	resetImagePreviews(t)
	outside := t.TempDir()
	writePicture(t, filepath.Join(outside, "secret.png"), 50, 50, false)
	dir := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(dir, "link.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "elsewhere")); err != nil {
		t.Fatal(err)
	}
	files := []ChangedFile{
		binaryFile("link.png", "A"),
		binaryFile("elsewhere/secret.png", "A"),
		binaryFile("../secret.png", "A"),
	}
	if got := withImagePreviews(dir, files, nil); len(got) != 0 {
		t.Fatalf("a picture reached through a symlink or a relative escape is not read: %+v", got)
	}
}

// End to end: the diff a turn reports carries the placeholder of the picture it added.
func TestLiveDiffCarriesAChangedPicturesPlaceholder(t *testing.T) {
	resetImagePreviews(t)
	repo := initRepo(t)
	baseSha := mustGit(t, repo, "rev-parse", "HEAD")
	writePicture(t, filepath.Join(repo, "docs/mocks/board.png"), 344, 913, false)
	if err := os.WriteFile(filepath.Join(repo, "notes.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, patches := liveDiff(&Worktree{Path: repo, BaseSha: baseSha})
	by := previewsByPath(patches)
	board, ok := by["docs/mocks/board.png"]
	if !ok || board.Width != 344 || board.Height != 913 {
		t.Fatalf("the added picture's placeholder is in the patches: files %+v, patches %+v", files, patches)
	}
	decodePreview(t, board, "image/jpeg")
	if by["notes.md"].Patch == "" {
		t.Fatalf("the text file keeps its patch: %+v", patches)
	}
}
