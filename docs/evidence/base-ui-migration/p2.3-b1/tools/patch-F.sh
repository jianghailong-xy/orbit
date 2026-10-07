#!/usr/bin/env bash
python3 /var/tmp/p23b1/scripts/patch-css-section.py "$1" && python3 /var/tmp/p23b1/scripts/patch-tsx-pin.py "$1"
