#!/usr/bin/env python3
import json
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
ROOT=Path('/Users/yordamkocatepe/clawd/mission-control')
out=ROOT/'data/runtime/workflow-intake-sentinel.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({'ok': True, 'updatedAt': datetime.now(ZoneInfo('Europe/Istanbul')).isoformat(), 'events': 0}, ensure_ascii=False, indent=2)+'\n')
print('NO_REPLY')
