#!/usr/bin/env python3
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
TARGET_FILE = PROJECT_ROOT / "node_modules/@libp2p/http-utils/dist/src/index.js"

def fix_http_utils():
    if not TARGET_FILE.exists():
        print("⚠️  @libp2p/http-utils not found, skipping patch")
        print(f"   Expected: {TARGET_FILE}")
        return 0
    
    try:
        with open(TARGET_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"❌ Error reading file: {e}")
        return 1
    
    # Check if already fixed
    if "addresses.port === '' ?" in content:
        print("✅ @libp2p/http-utils already patched")
        return 0
    
    old_pattern = "port = parseInt(addresses.port, 10);"
    new_pattern = "port = parseInt(addresses.port === '' ? (addresses.protocol === 'https:' ? '443' : '80') : addresses.port, 10);"
    
    if old_pattern not in content:
        print("⚠️  @libp2p/http-utils: Pattern not found, file may have changed")
        print(f"   Looking for: {old_pattern}")
        return 0
    
    fixed_content = content.replace(old_pattern, new_pattern)
    
    if fixed_content == content:
        print("⚠️  @libp2p/http-utils: No changes made")
        return 0
    
    try:
        with open(TARGET_FILE, 'w', encoding='utf-8') as f:
            f.write(fixed_content)
        print("✅ Successfully patched @libp2p/http-utils")
        return 0
    except Exception as e:
        print(f"❌ Error writing file: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(fix_http_utils())
