#!/bin/sh
# Minimal offline builder. Prefer Android Studio/Gradle for normal development.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
BUILD="$HERE/app/build/minimal"
SRC="$HERE/app/src/main"
# Shared with the Gradle build; do not put secrets in version.properties.
. "$HERE/version.properties"
JAVA=${JAVA:-java}
: "${AAPT2:?Set AAPT2 to the Android aapt2 executable}"
: "${ANDROID_JAR:?Set ANDROID_JAR to API 34 android.jar}"
: "${ECJ_JAR:?Set ECJ_JAR to Eclipse Java compiler}"
: "${D8_JAR:?Set D8_JAR to Android D8}"
: "${APKSIGNER_JAR:?Set APKSIGNER_JAR to Android apksigner.jar}"
: "${KEYSTORE:?Set KEYSTORE to the PRIVATE release keystore outside the repository}"
: "${STOREPASS_FILE:?Set STOREPASS_FILE to a PRIVATE file containing the keystore password}"
KEY_ALIAS=${KEY_ALIAS:-openstreet-release}
OUT=${OUT:-"$HERE/app/build/outputs/apk/release/OpenStreet-v$VERSION_NAME.apk"}
case "$(realpath "$KEYSTORE")" in "$ROOT"/*) echo 'Keep the private keystore outside the repository.' >&2; exit 1;; esac
case "$(realpath "$STOREPASS_FILE")" in "$ROOT"/*) echo 'Keep the password outside the repository.' >&2; exit 1;; esac

rm -rf "$BUILD"
mkdir -p "$BUILD/assets/game" "$BUILD/classes" "$BUILD/dex" "$(dirname -- "$OUT")"
GAME="$BUILD/assets/game"
cp "$ROOT/game/index.html" "$ROOT/game/manifest.json" "$ROOT/game/sw.js" "$ROOT/game/README.md" "$ROOT/game/ASSET-CREDITS.md" "$GAME/"
cp -R "$ROOT/game/css" "$ROOT/game/js" "$ROOT/game/icons" "$ROOT/game/vendor" "$ROOT/game/assets" "$GAME/"

python3 "$HERE/tools/prepare-manifest.py" "$HERE/version.properties" "$SRC/AndroidManifest.xml" "$BUILD/AndroidManifest.xml"
"$AAPT2" compile --dir "$SRC/res" -o "$BUILD/resources.zip"
"$AAPT2" link -I "$ANDROID_JAR" --manifest "$BUILD/AndroidManifest.xml" -A "$BUILD/assets" \
    --auto-add-overlay -o "$BUILD/resources.apk" "$BUILD/resources.zip"
"$JAVA" -jar "$ECJ_JAR" -source 8 -target 8 -encoding UTF-8 -bootclasspath "$ANDROID_JAR" \
    -classpath "$ANDROID_JAR" -d "$BUILD/classes" "$SRC/java/ru/openstreet/game/AssetPolicy.java" "$SRC/java/ru/openstreet/game/MainActivity.java"
find "$BUILD/classes" -name '*.class' -print0 | xargs -0 "$JAVA" -cp "$D8_JAR" com.android.tools.r8.D8 \
    --release --min-api "$MIN_SDK" --lib "$ANDROID_JAR" --output "$BUILD/dex"
python3 "$HERE/tools/align-apk.py" "$BUILD/resources.apk" "$BUILD/dex/classes.dex" "$BUILD/aligned-unsigned.apk"
"$JAVA" -jar "$APKSIGNER_JAR" sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
    --ks-pass "file:$STOREPASS_FILE" --v1-signing-enabled true --v2-signing-enabled true \
    --v3-signing-enabled true --v4-signing-enabled false --out "$OUT" "$BUILD/aligned-unsigned.apk"
"$JAVA" -jar "$APKSIGNER_JAR" verify --verbose --print-certs "$OUT"
python3 "$HERE/tools/align-apk.py" --check "$OUT"
echo "Release APK: $OUT"
