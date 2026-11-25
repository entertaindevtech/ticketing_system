"""Approximate IP geolocation with MaxMind GeoLite2 City.

This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.

The lookup runs once, when a referral session is created. Failures never block a booking:
they simply produce an empty snapshot that reports as "Unknown".
"""
import ipaddress
import logging
import os
import threading

log = logging.getLogger("mgm.geo")

UNKNOWN = "Unknown"
OUTSIDE_INDIA = "Outside India"


def client_ip(xff: str | None, peer: str | None, trusted_hops: int) -> str | None:
    """Return the client's public IP, trusting only the last `trusted_hops` proxies.

    Each trusted proxy appends the address it received the request from, so the client is
    the entry `trusted_hops` from the right. Anything further left is client-supplied and
    ignored, which stops visitors spoofing their location by sending their own header.
    """
    candidate = peer
    if trusted_hops > 0 and xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        candidate = parts[-trusted_hops] if len(parts) >= trusted_hops else None
    try:
        ip = ipaddress.ip_address((candidate or "").strip())
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return str(ip) if ip.is_global else None


class GeoLookup:
    """Thread-safe GeoLite2 reader that picks up a replaced .mmdb file without a restart.

    scripts/update_geoip.py writes the new file beside the old one and os.replace()s it in,
    so a reader never sees a half-written database.
    """

    def __init__(self, path: str):
        self.path = path
        self._reader = None
        self._mtime = None
        self._lock = threading.Lock()

    def _current_reader(self):
        try:
            mtime = os.stat(self.path).st_mtime
        except OSError:
            return None
        if mtime != self._mtime:
            with self._lock:
                if mtime != self._mtime:
                    import maxminddb  # imported lazily so the app runs without the package/file

                    old = self._reader
                    try:
                        self._reader = maxminddb.open_database(self.path)
                        self._mtime = mtime
                        log.info("GeoLite2 database loaded from %s", self.path)
                    except Exception:  # corrupt/partial file: keep the previous reader
                        log.exception("Could not open GeoLite2 database at %s", self.path)
                    else:
                        if old is not None:
                            old.close()
        return self._reader

    @property
    def available(self) -> bool:
        return self._current_reader() is not None

    def lookup(self, ip: str | None) -> dict:
        empty = {"geo_country_code": None, "geo_country": None, "geo_region": None, "geo_city": None}
        if not ip:
            return empty
        try:
            reader = self._current_reader()
            rec = reader.get(ip) if reader else None
        except Exception:
            log.exception("GeoLite2 lookup failed")
            return empty
        if not rec:
            return empty
        name = lambda node: (node or {}).get("names", {}).get("en")  # noqa: E731
        subs = rec.get("subdivisions") or []
        return {
            "geo_country_code": (rec.get("country") or {}).get("iso_code"),
            "geo_country": name(rec.get("country")),
            "geo_region": name(subs[0]) if subs else None,
            "geo_city": name(rec.get("city")),
        }


def region_bucket(country_code: str | None, region: str | None) -> str:
    """State-level bucket for India-focused reporting."""
    if not country_code:
        return UNKNOWN
    if country_code != "IN":
        return OUTSIDE_INDIA
    return region or UNKNOWN


def city_bucket(country_code: str | None, city: str | None) -> str:
    if not country_code:
        return UNKNOWN
    if country_code != "IN":
        return OUTSIDE_INDIA
    return city or UNKNOWN
