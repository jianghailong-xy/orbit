package main

import "path/filepath"

// reposDirName is the directory this machine keeps checkouts under, below the user's home. A
// convention rather than a setting, so a machine can name its root without anything being
// configured on it first.
const reposDirName = "orbit-repos"

// reposRoot is the root this machine reports on every heartbeat. Empty when this account has no
// resolvable home directory, which is reported as "no root" rather than guessed at: a path Orbit
// invented is a directory the user never agreed to.
func reposRoot() string {
	home := userHome()
	if home == "" {
		return ""
	}
	return filepath.Join(home, reposDirName)
}
