#!/usr/bin/env bash
# One-click launcher for the DEM Viewer on macOS / Linux.
cd "$(dirname "$0")"

PORT=8765
URL="http://localhost:${PORT}"

echo "Starting local web server on port ${PORT}..."
echo "The viewer will open in your browser. Keep this window open."
echo "Press Ctrl+C to stop."
echo

# Open browser shortly after the server starts
(
  sleep 1.5
  if command -v open >/dev/null 2>&1; then
    open "$URL"        # macOS
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"    # Linux
  fi
) &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT"
elif command -v node >/dev/null 2>&1; then
  npx --yes http-server -p "$PORT" -c-1 .
else
  echo
  echo "ERROR: Neither Python nor Node.js was found on your system."
  echo "Install Python 3 with:"
  echo "  macOS:  brew install python3"
  echo "  Linux:  sudo apt install python3   (or your distro's equivalent)"
  exit 1
fi
