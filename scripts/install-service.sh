#!/bin/sh
# Runs the outliner server in the background at login (macOS launchd), restarting it if it exits.
set -eu

LABEL=local.outliner
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
PORT=${PORT:-4477}
HOST=${HOST:-127.0.0.1}   # HOST=0.0.0.0 makes it reachable from other devices on the network
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/outliner.log"
DOMAIN="gui/$(id -u)"

# A server started with `npm start` holds the port and would make the service crash-loop.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is in use — stop the running server (Ctrl+C on npm start) and run this again." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootstrap "$DOMAIN" "$PLIST"
sleep 1
if curl -fsS "http://localhost:$PORT/api/outline" >/dev/null; then
  echo "Outliner is running at http://localhost:$PORT and will start at every login."
  echo "Log: $LOG"
else
  echo "Service installed but not answering yet — check $LOG" >&2
  exit 1
fi
