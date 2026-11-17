//go:build !linux

package main

import "errors"

// execBrowserStarter: the managed runner browser runs only in the managed runner image, which is Linux.
type execBrowserStarter struct{}

func (execBrowserStarter) Start(string, []string) (browserProcess, error) {
	return nil, errors.New("the browser runs only on Linux")
}

func (execBrowserStarter) WaitDisplay(string) error {
	return errors.New("the browser runs only on Linux")
}

func (execBrowserStarter) Reap() {}
