#!/bin/sh
# Stops the background outliner server and removes it from login. Data is left untouched.
set -eu

LABEL=local.outliner
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Outliner service removed. Your data in data/ is untouched."
