package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Blur-up placeholders for the pictures a session changed (docs/mocks/worktree-file-preview-web,
// 02-blur-up). A changed picture has no text diff: the web's diff drawer reads its bytes from the
// worktree when it is opened (GET /sessions/:id/worktree-file), which costs this runner's round trip
// plus the download of the whole file — 1.2–2.2 MB for a mock board. So when this runner reports a
// diff, each changed PNG, JPEG or GIF also gets a tiny copy, about 2.5 KB, that the drawer draws
// blurred at the picture's own size the moment the file opens, until the picture itself has loaded.
const (
	// The placeholder's width, and the cap on its longest side for a very tall or wide picture.
	imagePreviewWidth   = 96
	imagePreviewMaxSide = 256
	// A picture with transparency keeps it: its placeholder is a PNG, which costs more bytes per
	// pixel than a JPEG, so it is made smaller.
	imagePreviewAlphaMaxSide = 48
	imagePreviewJPEGQuality  = 50
	// Placeholders kept per file version, so a report decodes only what changed since the last one.
	// A few KB each.
	imagePreviewCacheSize = 2048
)

// Bounds on the work and the payload, variables for the tests. Decoding is the cost — about 0.15 s
// for a 3440 × 9130 board — and a diff report is on the path of a turn's completion, so a report
// starts no new decode past its time budget; what it skips is decoded by a later report.
var (
	imagePreviewMaxPixels   int64 = 64_000_000
	imagePreviewMaxBytes    int64 = 25 << 20
	imagePreviewTimeBudget        = 1500 * time.Millisecond
	imagePreviewReportBytes       = 128 << 10
)

// imagePreview is one picture's placeholder: a data URL, and the picture's own pixel size. An empty
// data URL records a file that cannot be drawn (not a picture, too large), so it is not tried again.
type imagePreview struct {
	dataURL       string
	width, height int
}

// withImagePreviews appends to patches a placeholder entry for each changed picture in the worktree
// at dir. A binary file has no entry of its own there (buildFilePatches), so this is its only one.
// Pictures it cannot or may not read — deleted, not a regular file inside the worktree, too large,
// not decodable, past the budget — get none, which the web reads as "no placeholder".
func withImagePreviews(dir string, files []ChangedFile, patches []FilePatch) []FilePatch {
	rootInfo, err := os.Lstat(dir)
	if err != nil || !rootInfo.IsDir() {
		return patches
	}
	start := time.Now()
	sent := 0
	for _, f := range files {
		if !imagePreviewCandidate(f) {
			continue
		}
		p := imagePreviewFor(dir, rootInfo, f.Path, time.Since(start) < imagePreviewTimeBudget)
		if p.dataURL == "" || sent+len(p.dataURL) > imagePreviewReportBytes {
			continue
		}
		sent += len(p.dataURL)
		patches = append(patches, FilePatch{Path: f.Path, Preview: p.dataURL, Width: p.width, Height: p.height})
	}
	return patches
}

// imagePreviewCandidate says whether a changed file is a picture this runner can draw a placeholder
// of: binary (git's numstat "-"), still in the worktree, and a format the standard library decodes.
func imagePreviewCandidate(f ChangedFile) bool {
	if f.Additions >= 0 && f.Deletions >= 0 {
		return false
	}
	if strings.HasPrefix(strings.ToUpper(f.Status), "D") {
		return false
	}
	switch strings.ToLower(path.Ext(f.Path)) {
	case ".png", ".jpg", ".jpeg", ".gif":
		return validWorktreeArtifactPath(f.Path)
	}
	return false
}

// imagePreviewFor returns one picture's placeholder, from the cache when this version of the file was
// seen before. Past the report's time budget (decode false) only the cache answers. The file is
// opened the way a worktree file request opens it (openWorktreeArtifactFile): never through a
// symlink, never outside the checkout.
func imagePreviewFor(dir string, rootInfo os.FileInfo, rel string, decode bool) imagePreview {
	file, err := openWorktreeArtifactFile(dir, filepath.FromSlash(rel), rootInfo)
	if err != nil {
		return imagePreview{}
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > imagePreviewMaxBytes {
		return imagePreview{}
	}
	key := imagePreviewKey{path: filepath.Join(dir, filepath.FromSlash(rel)), size: info.Size(), modTime: info.ModTime().UnixNano()}
	if p, ok := imagePreviews.get(key); ok {
		return p
	}
	if !decode {
		return imagePreview{}
	}
	p := makeImagePreview(file)
	imagePreviews.put(key, p)
	return p
}

// makeImagePreview decodes the picture and encodes its placeholder: a JPEG for an opaque picture, a
// smaller PNG for one with transparency, which a JPEG would turn black. The pixel count is checked
// from the header before anything is decoded.
func makeImagePreview(file io.ReadSeeker) imagePreview {
	cfg, _, err := image.DecodeConfig(bufio.NewReader(file))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > imagePreviewMaxPixels {
		return imagePreview{}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return imagePreview{}
	}
	src, _, err := image.Decode(bufio.NewReader(file))
	if err != nil {
		return imagePreview{}
	}
	opaque := true
	if o, ok := src.(interface{ Opaque() bool }); ok {
		opaque = o.Opaque()
	}
	maxSide := imagePreviewMaxSide
	if !opaque {
		maxSide = imagePreviewAlphaMaxSide
	}
	small := shrinkImage(src, maxSide)
	var buf bytes.Buffer
	mime := "image/jpeg"
	if opaque {
		err = jpeg.Encode(&buf, small, &jpeg.Options{Quality: imagePreviewJPEGQuality})
	} else {
		mime = "image/png"
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, small)
	}
	if err != nil {
		return imagePreview{}
	}
	return imagePreview{
		dataURL: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(buf.Bytes()),
		width:   cfg.Width,
		height:  cfg.Height,
	}
}

// shrinkImage scales src down to imagePreviewWidth wide (never up), with its longest side at most
// maxSide, averaging every source pixel into the placeholder pixel it falls in: a sampled shrink
// turns a board's thin text lines into noise.
func shrinkImage(src image.Image, maxSide int) *image.NRGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	w := min(imagePreviewWidth, sw, maxSide)
	h := max(1, (sh*w+sw/2)/sw)
	if h > maxSide {
		h = maxSide
		w = max(1, (sw*h+sh/2)/sh)
	}
	at := func(x, y int) (r, g, b, a uint32) { return src.At(x, y).RGBA() }
	if fast, ok := src.(image.RGBA64Image); ok {
		at = func(x, y int) (r, g, b, a uint32) {
			c := fast.RGBA64At(x, y)
			return uint32(c.R), uint32(c.G), uint32(c.B), uint32(c.A)
		}
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		y0, y1 := b.Min.Y+y*sh/h, b.Min.Y+(y+1)*sh/h
		for x := 0; x < w; x++ {
			x0, x1 := b.Min.X+x*sw/w, b.Min.X+(x+1)*sw/w
			var r, g, bl, a, n uint64
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					cr, cg, cb, ca := at(xx, yy)
					r, g, bl, a, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), a+uint64(ca), n+1
				}
			}
			i := dst.PixOffset(x, y)
			if a > 0 {
				// Premultiplied sums over the alpha sum: the straight colour of what is visible.
				dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2] = uint8(r*255/a), uint8(g*255/a), uint8(bl*255/a)
			}
			dst.Pix[i+3] = uint8(a / n >> 8)
		}
	}
	return dst
}

type imagePreviewKey struct {
	path          string
	size, modTime int64
}

// imagePreviewCache keeps placeholders per file version, dropping the oldest past its size.
type imagePreviewCache struct {
	mu      sync.Mutex
	entries map[imagePreviewKey]imagePreview
	order   []imagePreviewKey
}

var imagePreviews = &imagePreviewCache{entries: map[imagePreviewKey]imagePreview{}}

func (c *imagePreviewCache) get(k imagePreviewKey) (imagePreview, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.entries[k]
	return p, ok
}

func (c *imagePreviewCache) put(k imagePreviewKey, p imagePreview) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[k]; ok {
		return
	}
	if len(c.order) >= imagePreviewCacheSize {
		delete(c.entries, c.order[0])
		c.order = c.order[1:]
	}
	c.entries[k] = p
	c.order = append(c.order, k)
}
