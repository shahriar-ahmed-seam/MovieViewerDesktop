#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f "$SCRIPT_DIR/release/linux-unpacked/movieviewer-desktop" ]; then
    "$SCRIPT_DIR/release/linux-unpacked/movieviewer-desktop" --no-sandbox "$@" &
elif [ -f "/opt/MovieViewer/movieviewer-desktop" ]; then
    /opt/MovieViewer/movieviewer-desktop --no-sandbox "$@" &
else
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    npm start &
fi
