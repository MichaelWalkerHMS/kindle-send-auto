#!/bin/sh
# Generates the Xcode project that wraps extension/ as a Safari web extension (macOS).
# Run on a Mac with Xcode installed: sh scripts/build-safari.sh
#
# The project references extension/ in place rather than copying it, so edits to the
# extension show up in Safari on the next Xcode build without re-running this script.
# Re-running it regenerates safari/ from scratch (--force), discarding Xcode changes
# such as the signing team.
set -e

cd "$(dirname "$0")/.."

BUNDLE_ID="${BUNDLE_ID:-io.github.michaelwalkerhms.KindleSend}"

# Newer Xcode calls the tool "packager"; older versions only have the "converter" name
if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
  TOOL=safari-web-extension-packager
else
  TOOL=safari-web-extension-converter
fi

xcrun "$TOOL" extension \
  --project-location safari \
  --app-name "Kindle Send" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --swift \
  --no-prompt \
  --force

# Newer Xcode derives the app's identifier from the app name ("Kindle-Send") instead of
# --bundle-identifier, while the extension gets "$BUNDLE_ID.Extension". Safari requires the
# extension's identifier to start with the app's, so set the app's identifier back to $BUNDLE_ID.
for f in "safari/Kindle Send/Kindle Send.xcodeproj/project.pbxproj" \
         "safari/Kindle Send/Kindle Send.xcodeproj/project.xcproj"; do
  [ -f "$f" ] && sed -i '' "s/$(echo "$BUNDLE_ID" | sed 's/KindleSend$/Kindle-Send/')\([\";]\)/$BUNDLE_ID\1/g" "$f"
done
exit 0
