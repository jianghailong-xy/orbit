//go:build !linux && !darwin

package main

import "os"

// clonedIndexStat is not known here: the checkout is filled as git writes it, and every entry is hashed as before.
func clonedIndexStat(os.FileInfo) (indexStatData, bool) {
	return indexStatData{}, false
}
