#!/bin/sh
# P5c fixture: a configuration ran me. Never part of an approved run.
echo "$* pid=$$" >> '__MARKERS__/markers.log'
