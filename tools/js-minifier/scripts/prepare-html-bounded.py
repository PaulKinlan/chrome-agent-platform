#!/usr/bin/env python3
from pathlib import Path
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
text = source.read_text()
old = '''var xhr;

function checkTypeSupport(type) {
  if (!xhr) {
    xhr = new global$1.XMLHttpRequest();
    // If location.host is empty, e.g. if this page/worker was loaded
    // from a Blob, then use example.com to avoid an error
    xhr.open('GET', global$1.location.host ? '/' : 'https://example.com');
  }
  try {
    xhr.responseType = type;
    return xhr.responseType === type
  } catch (e) {
    return false
  }

}
'''
new = '''var xhr = {};

function checkTypeSupport(_type) {
  return false
}
'''
if text.count(old) != 1:
    raise SystemExit('expected exact HTML network capability probe once')
text = text.replace(old, new)
text = text.replace('.fetch(', '.__bounded_fetch_disabled(')
text = text.replace('.XMLHttpRequest', '.__bounded_XMLHttpRequest_disabled')
if '.fetch(' in text or '.XMLHttpRequest' in text:
    raise SystemExit('HTML network callsite remained')
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(text)
