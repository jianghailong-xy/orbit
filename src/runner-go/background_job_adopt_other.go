//go:build !linux && !darwin

package main

import (
	"fmt"
	"os"
)

// adoptRecordedJobs adopts nothing where the runner never re-executes into a self-update
// (selfupdate.go platformKey): a record found here was left by a runner that stopped some other way,
// and is discarded as a job with no end report.
func (p *sessionPool) adoptRecordedJobs() {
	for _, found := range readBgJobRecords() {
		logln(fmt.Sprintf("background job record %s: not adopted on this platform, no end report", found.path))
		_ = os.Remove(found.path)
	}
}
