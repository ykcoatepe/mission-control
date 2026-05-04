#!/usr/bin/env python3
import json, sys
print(json.dumps({'ok': True, 'argv': sys.argv[1:], 'status': 'compatibility-wrapper'}))
