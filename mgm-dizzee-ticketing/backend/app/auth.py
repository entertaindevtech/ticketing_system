"""Staff and administrator authentication.

- Accounts (users) with Argon2id password hashes; per-account lockout after repeated failures.
- Server-side sessions in PostgreSQL (auth_sessions), carried by an HttpOnly, SameSite=Lax cookie. Only a SHA-256
  of the session token is stored.
- Cookie-authenticated writes must carry the X-Requested-With: mgm-app header. Browsers cannot add that header
  cross-site without a CORS preflight, which only the configured origins pass (CSRF protection).
- Roles: admin (everything), finance, counter, gate, marketing. require_roles() is the only gate on staff routes.
- ADMIN_API_TOKEN remains a break-glass / automation credential acting as "admin". If it is unset, too short or a
  placeholder, that path is simply disabled (fails closed); unset it once real admin accounts exist.
"""
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuthSession, User, as_utc, utcnow

ROLES = ("admin", "finance", "counter", "gate", "marketing")
COOKIE = "mgm_session"
CSRF_HEADER_VALUE = "mgm-app"
PLACEHOLDER_TOKENS = {"change-me-to-a-long-random-string", "changeme", "admin"}
MIN_TOKEN_LEN = 24
MIN_PASSWORD_LEN = 10
MAX_FAILURES, LOCK_MINUTES = 5, 15
SESSION_HOURS = 12

_hasher = PasswordHasher()  # argon2-cffi defaults: Argon2id, RFC 9106 low-memory profile
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-password")


@dataclass
class Actor:
    code: str
    name: str
    roles: tuple[str, ...]
    gate: str | None = None
    user_id: int | None = None

    def has(self, *roles: str) -> bool:
        return "admin" in self.roles or any(r in self.roles for r in roles)


def hash_password(pw: str) -> str:
    if len(pw) < MIN_PASSWORD_LEN:
        raise ValueError(f"Passwords need at least {MIN_PASSWORD_LEN} characters")
    return _hasher.hash(pw)


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class LoginError(Exception):
    pass


def authenticate(db: Session, code: str, password: str) -> User:
    u = db.scalar(select(User).where(User.code == code.strip().upper()))
    if not u:
        try:  # same work as a real check, so unknown accounts can't be detected by timing
            _hasher.verify(_DUMMY_HASH, password)
        except VerificationError:
            pass
        raise LoginError("Invalid staff ID or password")
    now = utcnow()
    if u.locked_until and as_utc(u.locked_until) > now:
        raise LoginError("Too many failed attempts. Try again in a few minutes.")
    try:
        _hasher.verify(u.password_hash, password)
    except (VerifyMismatchError, InvalidHashError, VerificationError):
        u.failed_attempts += 1
        if u.failed_attempts >= MAX_FAILURES:
            u.failed_attempts, u.locked_until = 0, now + timedelta(minutes=LOCK_MINUTES)
        db.commit()
        raise LoginError("Invalid staff ID or password")
    if not u.active:
        raise LoginError("This account is disabled")
    if _hasher.check_needs_rehash(u.password_hash):
        u.password_hash = _hasher.hash(password)
    u.failed_attempts, u.locked_until, u.last_login_at = 0, None, now
    return u


def start_session(db: Session, u: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token_hash=_sha(token), user_id=u.id, expires_at=utcnow() + timedelta(hours=SESSION_HOURS)))
    return token


def end_session(db: Session, token: str | None):
    if token:
        s = db.scalar(select(AuthSession).where(AuthSession.token_hash == _sha(token)))
        if s:
            db.delete(s)


def revoke_user_sessions(db: Session, user_id: int):
    for s in db.scalars(select(AuthSession).where(AuthSession.user_id == user_id)):
        db.delete(s)


def _token_actor(request: Request, token: str | None) -> Actor | None:
    expected = request.app.state.settings.admin_api_token
    usable = expected and len(expected) >= MIN_TOKEN_LEN and expected not in PLACEHOLDER_TOKENS
    if usable and token and hmac.compare_digest(token, expected):
        return Actor(code="ADMIN", name="Admin (API token)", roles=("admin",))
    return None


def session_user(request: Request, db: Session) -> User | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    s = db.scalar(select(AuthSession).where(AuthSession.token_hash == _sha(token)))
    if not s or as_utc(s.expires_at) <= utcnow():
        return None
    u = db.get(User, s.user_id)
    return u if u and u.active else None


def current_actor(request: Request, x_admin_token: str | None = Header(default=None),
                  x_requested_with: str | None = Header(default=None)) -> Actor | None:
    a = _token_actor(request, x_admin_token)
    if a:
        return a
    with request.app.state.sessionmaker() as db:
        u = session_user(request, db)
        if not u:
            return None
        if request.method not in ("GET", "HEAD", "OPTIONS") and x_requested_with != CSRF_HEADER_VALUE:
            raise HTTPException(403, "Missing X-Requested-With header")
        return Actor(code=u.code, name=u.name, roles=tuple(u.roles.split(",")), gate=u.gate, user_id=u.id)


def require_roles(*roles: str):
    def dep(actor: Actor | None = Depends(current_actor)) -> Actor:
        if not actor:
            raise HTTPException(401, "Sign in required")
        if not actor.has(*roles):
            raise HTTPException(403, "Your account does not have access to this")
        return actor
    return dep
