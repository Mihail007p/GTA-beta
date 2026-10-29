#!/usr/bin/env python3
"""Supply the same package/version/SDK values Gradle supplies for the minimal builder."""
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

props = dict(line.strip().split('=', 1) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip() and not line.startswith('#'))
android = 'http://schemas.android.com/apk/res/android'
ET.register_namespace('android', android)
tree = ET.parse(sys.argv[2])
root = tree.getroot()
root.set('package', props['APP_ID'])
root.set('{' + android + '}versionCode', str(int(props['VERSION_CODE'])))
root.set('{' + android + '}versionName', props['VERSION_NAME'])
uses_sdk = ET.Element('uses-sdk', {
    '{' + android + '}minSdkVersion': str(int(props['MIN_SDK'])),
    '{' + android + '}targetSdkVersion': str(int(props['TARGET_SDK'])),
})
root.insert(0, uses_sdk)
tree.write(sys.argv[3], encoding='utf-8', xml_declaration=True)
