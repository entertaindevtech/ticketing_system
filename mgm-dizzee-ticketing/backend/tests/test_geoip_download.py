"""GeoLite2 download against a local stand-in for MaxMind + Cloudflare R2.

The fake permalink checks HTTP Basic auth and answers 302 to a different host (like the real R2 presigned URL);
the fake R2 rejects any request that still carries an Authorization header with 400, as R2 does.
"""
import base64
import io
import logging
import sys
import tarfile
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import geoip_update

ACCOUNT, KEY = "123456", "secret-license-key-zzz"
GOOD_AUTH = "Basic " + base64.b64encode(f"{ACCOUNT}:{KEY}".encode()).decode()


def tarball(payload=b"MMDB-BYTES"):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        info = tarfile.TarInfo("GeoLite2-City_20261126/GeoLite2-City.mmdb")
        info.size = len(payload)
        t.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


def serve(handler_cls):
    srv = HTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture
def maxmind(monkeypatch):
    """Starts fake R2 (on localhost) and fake MaxMind (on 127.0.0.1): different hosts, like production."""
    seen = {"r2_auth": "unset", "r2_hits": 0}

    class R2(BaseHTTPRequestHandler):
        def do_GET(self):
            seen["r2_hits"] += 1
            seen["r2_auth"] = self.headers.get("Authorization")
            if self.headers.get("Authorization"):
                body = b"<Error><Code>InvalidArgument</Code><Message>Only one auth mechanism allowed</Message></Error>"
                self.send_response(400)
            else:
                body = tarball()
                self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    r2 = serve(R2)

    class MaxMind(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get("Authorization") != GOOD_AUTH:
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b"Invalid account ID or license key")
                return
            self.send_response(302)
            self.send_header("Location", f"http://localhost:{r2.server_port}/geoip-databases/GeoLite2-City.tar.gz?X-Amz-Signature=abc")
            self.end_headers()

        def log_message(self, *a):
            pass

    mm = serve(MaxMind)
    monkeypatch.setattr(geoip_update, "URL", f"http://127.0.0.1:{mm.server_port}/geoip/databases/GeoLite2-City/download?suffix=tar.gz")
    # the archive's payload is not a real database; accept it in place of maxminddb's validation
    monkeypatch.setitem(sys.modules, "maxminddb", types.SimpleNamespace(open_database=lambda p: types.SimpleNamespace(close=lambda: None)))
    monkeypatch.setenv("MAXMIND_ACCOUNT_ID", ACCOUNT)
    monkeypatch.setenv("MAXMIND_LICENSE_KEY", KEY)
    yield seen
    mm.shutdown()
    r2.shutdown()


def test_download_follows_redirect_without_forwarding_credentials(tmp_path, maxmind):
    p = tmp_path / "data" / "GeoLite2-City.mmdb"
    assert geoip_update.refresh(str(p)) is True
    assert p.read_bytes() == b"MMDB-BYTES"
    assert maxmind["r2_hits"] == 1 and maxmind["r2_auth"] is None  # the presigned URL never sees the license key


def test_wrong_credentials_report_maxmind_401_without_leaking_the_key(tmp_path, maxmind, monkeypatch, caplog):
    monkeypatch.setenv("MAXMIND_LICENSE_KEY", "wrong-key")
    with caplog.at_level(logging.ERROR, logger="mgm.geoip_update"):
        assert geoip_update.refresh(str(tmp_path / "GeoLite2-City.mmdb")) is False
    assert "HTTP 401 from 127.0.0.1" in caplog.text and "Invalid account ID" in caplog.text
    assert "wrong-key" not in caplog.text and maxmind["r2_hits"] == 0


def test_error_from_redirect_target_is_reported_with_its_host_and_body(tmp_path, maxmind, monkeypatch, caplog):
    # simulate the old behaviour (credentials forwarded): R2 answers 400 and the log says so, safely
    real = geoip_update.urllib.request.Request

    class Forwarding(real):
        def add_unredirected_header(self, k, v):
            self.add_header(k, v)
    monkeypatch.setattr(geoip_update.urllib.request, "Request", Forwarding)
    existing = tmp_path / "GeoLite2-City.mmdb"
    existing.write_bytes(b"old")
    import os
    os.utime(existing, (0, 0))
    with caplog.at_level(logging.ERROR, logger="mgm.geoip_update"):
        assert geoip_update.refresh(str(existing)) is False
    assert "HTTP 400 from localhost" in caplog.text and "Only one auth mechanism allowed" in caplog.text
    assert KEY not in caplog.text and "X-Amz-Signature" not in caplog.text
    assert existing.read_bytes() == b"old" and not (tmp_path / "GeoLite2-City.mmdb.tmp").exists()
