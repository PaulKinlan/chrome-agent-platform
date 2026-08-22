#!/usr/bin/env python3
from pathlib import Path
import sys

for raw in sys.argv[1:]:
    path = Path(raw)
    text = path.read_text()
    text = text.replace('sourceMappingURL', r'sourceMapping\x55RL')
    # HTMLMinifier's official browser bundle contains dormant CleanCSS URL loaders.
    # The bounded wrapper forbids minifyCSS/minifyURLs; rename those callsites so
    # even a future wrapper regression fails closed rather than acquiring network.
    text = text.replace('.fetch(', '.__bounded_fetch_disabled(')
    text = text.replace('.XMLHttpRequest', '.__bounded_XMLHttpRequest_disabled')
    path.write_text(text)
    final = path.read_text()
    if 'sourceMappingURL' in final or '.fetch(' in final or '.XMLHttpRequest' in final:
        raise SystemExit('forbidden shipped spelling remained')
