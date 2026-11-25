"""Download / refresh the MaxMind GeoLite2 City database.

Needs MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY (free GeoLite account). Writes to GEOIP_DB_PATH
(on Railway, a path on the mounted volume, e.g. /data/GeoLite2-City.mmdb).

The new file is fully written and validated next to the target, then swapped in with os.replace(),
which is atomic on the same filesystem, so running lookups never see a partial file; GeoLookup
notices the new mtime and reopens it. Any failure keeps the existing database.

This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.
"""
import base64
import io
import logging
import os
import tarfile
import threading
import time
import urllib.request

log = logging.getLogger("mgm.geoip_update")
URL = "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz"


def credentials() -> tuple[str, str] | None:
    account, key = os.environ.get("MAXMIND_ACCOUNT_ID"), os.environ.get("MAXMIND_LICENSE_KEY")
    return (account, key) if account and key else None


def refresh(path: str, max_age_days: float = 7) -> bool:
    """Download a fresh copy if the file is missing or older than max_age_days. Returns True if updated."""
    try:
        if time.time() - os.stat(path).st_mtime < max_age_days * 86400:
            return False
    except OSError:
        pass  # missing
    creds = credentials()
    if not creds:
        log.warning("MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY not set - GeoLite2 not downloaded; regions will show as Unknown")
        return False
    req = urllib.request.Request(URL, headers={"Authorization": "Basic " + base64.b64encode(f"{creds[0]}:{creds[1]}".encode()).decode()})
    tmp = path + ".tmp"
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            blob = r.read()
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            member = next(m for m in tar.getmembers() if m.isfile() and m.name.endswith("GeoLite2-City.mmdb"))
            data = tar.extractfile(member).read()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        import maxminddb

        maxminddb.open_database(tmp).close()  # validate before swapping in
        os.replace(tmp, path)
    except Exception:
        log.exception("GeoLite2 download failed; keeping the existing database")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False
    log.info("GeoLite2 City database updated at %s (%d KiB)", path, len(data) // 1024)
    return True


def start_background_refresh(path: str, interval_hours: float = 24) -> None:
    """Checks daily; downloads when the file is over a week old (MaxMind publishes twice weekly)."""
    if not credentials():
        return

    def loop():
        while True:
            refresh(path)
            time.sleep(interval_hours * 3600)

    threading.Thread(target=loop, name="geoip-refresh", daemon=True).start()
