import os
import time

from app import geoip_update


def test_fresh_file_is_not_redownloaded(tmp_path, monkeypatch):
    p = tmp_path / "GeoLite2-City.mmdb"
    p.write_bytes(b"x")
    monkeypatch.setenv("MAXMIND_ACCOUNT_ID", "1")
    monkeypatch.setenv("MAXMIND_LICENSE_KEY", "k")
    monkeypatch.setattr(geoip_update.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no download expected")))
    assert geoip_update.refresh(str(p)) is False


def test_failed_download_keeps_existing_file(tmp_path, monkeypatch):
    p = tmp_path / "GeoLite2-City.mmdb"
    p.write_bytes(b"old")
    old = time.time() - 10 * 86400
    os.utime(p, (old, old))
    monkeypatch.setenv("MAXMIND_ACCOUNT_ID", "1")
    monkeypatch.setenv("MAXMIND_LICENSE_KEY", "k")

    def boom(*a, **k):
        raise OSError("network down")
    monkeypatch.setattr(geoip_update.urllib.request, "urlopen", boom)
    assert geoip_update.refresh(str(p)) is False
    assert p.read_bytes() == b"old" and not (tmp_path / "GeoLite2-City.mmdb.tmp").exists()


def test_missing_credentials_skip_quietly(tmp_path, monkeypatch):
    monkeypatch.delenv("MAXMIND_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("MAXMIND_LICENSE_KEY", raising=False)
    assert geoip_update.refresh(str(tmp_path / "missing.mmdb")) is False
