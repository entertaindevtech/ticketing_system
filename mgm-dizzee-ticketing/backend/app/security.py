"""Signed identifiers: ticket QR codes and customer booking-access tokens (HMAC-SHA256 with APP_SECRET)."""
import base64
import hashlib
import hmac
import secrets

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # same as the prototype: no 0/O/1/I


def random_code(n: int) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(n))


def _mac(secret: str, msg: str) -> bytes:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()


def qr_payload(secret: str, ticket_code: str, booking_ref: str, visit_date: str) -> str:
    base = f"MGMDW2|{ticket_code}|{booking_ref}|{visit_date}"
    return f"{base}|{base64.b32encode(_mac(secret, 'qr|' + base)).decode()[:12]}"


def parse_qr(secret: str, raw: str) -> tuple[str | None, str]:
    """-> (ticket_code, error). Accepts a signed MGMDW2 payload, a legacy MGMDW1 payload (its signature proves
    nothing; the ticket must exist in the database) or a bare ticket code typed by staff."""
    code = raw.strip()
    if code.startswith("MGMDW2|"):
        parts = code.split("|")
        if len(parts) != 5 or not hmac.compare_digest(qr_payload(secret, parts[1], parts[2], parts[3]), code):
            return None, "Invalid QR code – signature check failed"
        return parts[1], ""
    if code.startswith("MGMDW1|"):
        parts = code.split("|")
        return (parts[1], "") if len(parts) == 5 else (None, "Invalid QR code")
    if 4 <= len(code) <= 16 and code.replace("-", "").isalnum():
        return code.upper(), ""
    return None, "Invalid QR code"


def access_token(secret: str, booking_ref: str) -> str:
    """Customer access token for one booking. Derived, so it can be re-sent without storing it."""
    return base64.urlsafe_b64encode(_mac(secret, "access|" + booking_ref)).decode().rstrip("=")[:32]


def check_access(secret: str, booking_ref: str, token: str | None) -> bool:
    return bool(token) and hmac.compare_digest(access_token(secret, booking_ref), token)
