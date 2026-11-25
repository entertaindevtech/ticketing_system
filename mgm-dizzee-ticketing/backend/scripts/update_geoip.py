"""Manually download / refresh the GeoLite2 City database.

Usage (from backend/):  python scripts/update_geoip.py [--force]

The running app also refreshes it automatically (daily check, see app/geoip_update.py).
"""
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.geoip_update import refresh  # noqa: E402

logging.basicConfig(level=logging.INFO)
path = os.environ.get("GEOIP_DB_PATH", "./data/GeoLite2-City.mmdb")
refresh(path, max_age_days=0 if "--force" in sys.argv else 7)
