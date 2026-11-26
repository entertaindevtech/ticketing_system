"""Offer images: upload, validation, replace, remove, public serving, and survival across offer edits."""
from sqlalchemy import func, select

from app.models import OfferImage
from .conftest import ADMIN

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64


def upload(client, blob, offer="o-family", ctype="image/png"):
    return client.put(f"/api/admin/offers/{offer}/image", content=blob, headers={**ADMIN, "Content-Type": ctype})


def offer(client, oid="o-family"):
    return next(o for o in client.get("/api/catalog").json()["offers"] if o["id"] == oid)


def test_upload_serve_replace_and_remove(client, db):
    assert "image" not in offer(client)                      # existing offers keep working without an image
    r = upload(client, PNG)
    assert r.status_code == 200
    url = offer(client)["image"]
    assert url == r.json()["image"] and url.startswith("/api/offers/o-family/image?v=")
    img = client.get(url)
    assert img.status_code == 200 and img.headers["content-type"] == "image/png" and img.content == PNG
    assert "max-age" in img.headers["cache-control"]
    assert upload(client, JPEG, ctype="image/png").status_code == 200   # replace; the type comes from the bytes
    assert client.get(url).headers["content-type"] == "image/jpeg"
    assert upload(client, WEBP, ctype="image/webp").status_code == 200
    assert db.scalar(select(func.count()).select_from(OfferImage)) == 1
    assert client.delete("/api/admin/offers/o-family/image", headers=ADMIN).json() == {"image": None}
    assert "image" not in offer(client) and client.get(url).status_code == 404


def test_rejects_bad_files_and_missing_offers(client):
    assert upload(client, b"GIF89a....", ctype="image/gif").status_code == 415
    assert upload(client, b"<svg xmlns='http://www.w3.org/2000/svg'/>", ctype="image/svg+xml").status_code == 415
    assert upload(client, b"").status_code == 422
    assert upload(client, PNG + b"\x00" * (2 * 1024 * 1024)).status_code == 413
    assert upload(client, PNG, offer="nope").status_code == 404
    assert client.put("/api/admin/offers/o-family/image", content=PNG).status_code == 401   # admin only
    assert client.get("/api/offers/o-family/image").status_code == 404


def test_image_survives_offer_edits_and_cannot_be_set_by_the_client(client):
    upload(client, PNG)
    url = offer(client)["image"]
    st = next(o for o in client.get("/api/admin/state", headers=ADMIN).json()["offers"] if o["id"] == "o-family")
    r = client.put("/api/admin/offers/o-family", json={**st, "packagePrice": 3299, "image": "https://evil.example/x.png"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["image"] == url and offer(client)["packagePrice"] == 3299
    new = {**st, "id": "o-new2", "name": "Fresh", "image": "https://evil.example/x.png", "status": "draft"}
    assert "image" not in client.put("/api/admin/offers/o-new2", json=new, headers=ADMIN).json()
    upload(client, PNG, offer="o-new2")
    assert client.delete("/api/admin/offers/o-new2", headers=ADMIN).status_code == 200   # unused offer deleted with its image


def test_commission_export_limit_allows_complete_lists(client):
    assert client.get("/api/admin/commissions", params={"limit": 100000}, headers=ADMIN).status_code == 200
    assert client.get("/api/admin/commissions", params={"limit": 0}, headers=ADMIN).status_code == 422
