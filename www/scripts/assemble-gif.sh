#!/usr/bin/env bash
# Assemble station-highlight GIF from scrns-captured frames.
# Usage: ./scripts/assemble-gif.sh [screenshots-dir] [output.gif]
set -euo pipefail

DIR="${1:-screenshots}"
OUT="${2:-screenshots/stations.gif}"
FPS=2
BEAT=3  # extra frames for first and last

cd "$(dirname "$0")/.."

# Build frame list with extra beats on first/last
FRAMES=$(mktemp)
trap "rm -f $FRAMES" EXIT

# Opening beat: all traces
for _ in $(seq $BEAT); do echo "file '$(pwd)/$DIR/gif-all.png'"; done >> "$FRAMES"

# Each station
LAST=$(ls "$DIR"/gif-*.png | grep -v gif-all | sort | tail -1)
for f in $(ls "$DIR"/gif-*.png | grep -v gif-all | sort); do
  REPEATS=1
  [ "$f" = "$(ls "$DIR"/gif-*.png | grep -v gif-all | sort | head -1)" ] && REPEATS=$BEAT
  [ "$f" = "$LAST" ] && REPEATS=$BEAT
  for _ in $(seq $REPEATS); do echo "file '$(pwd)/$f'"; done >> "$FRAMES"
done

# Closing beat: all traces
for _ in $(seq $BEAT); do echo "file '$(pwd)/$DIR/gif-all.png'"; done >> "$FRAMES"

echo "Assembling $(wc -l < "$FRAMES" | tr -d ' ') frames → $OUT"
ffmpeg -y -f concat -safe 0 -r "$FPS" -i "$FRAMES" \
  -vf "scale=${3:-1200}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  "$OUT"
echo "Done: $OUT ($(du -h "$OUT" | cut -f1))"
