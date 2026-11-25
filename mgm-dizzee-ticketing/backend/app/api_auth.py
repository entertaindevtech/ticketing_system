"""Staff sign-in / sign-out and account management (admins only)."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import auth
from .api import get_db
from .bookings import audit, ist
from .models import User

auth_api = APIRouter(prefix="/api")
STAFF_CODE = r"^[A-Za-z0-9_-]{3,32}$"


class LoginIn(BaseModel):
    code: str = Field(pattern=STAFF_CODE)
    password: str = Field(min_length=1, max_length=200)


class PasswordIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(min_length=auth.MIN_PASSWORD_LEN, max_length=200)


class UserIn(BaseModel):
    code: str = Field(pattern=STAFF_CODE)
    name: str = Field(min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=40)
    gate: str | None = Field(default=None, max_length=60)
    roles: list[str] = Field(min_length=1)
    password: str = Field(min_length=auth.MIN_PASSWORD_LEN, max_length=200)
    active: bool = True


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    phone: str | None = Field(default=None, max_length=40)
    gate: str | None = Field(default=None, max_length=60)
    roles: list[str] | None = None
    password: str | None = Field(default=None, min_length=auth.MIN_PASSWORD_LEN, max_length=200)
    active: bool | None = None


def user_out(u: User) -> dict:
    """The prototype's Staff shape (no password, ever) plus account fields."""
    return {"id": u.code, "name": u.name, "phone": u.phone or "", "gate": u.gate or "", "role": ", ".join(u.roles.split(",")),
            "roles": u.roles.split(","), "active": u.active, "lastLoginAt": ist(u.last_login_at) or None}


def _roles(roles: list[str]) -> str:
    bad = [r for r in roles if r not in auth.ROLES]
    if bad:
        raise HTTPException(422, f"Unknown role(s): {', '.join(bad)}. Use {', '.join(auth.ROLES)}")
    return ",".join(dict.fromkeys(roles))


def _secure(request: Request) -> bool:
    return request.url.scheme == "https" or request.app.state.settings.app_env != "development"


@auth_api.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    try:
        u = auth.authenticate(db, body.code, body.password)
    except auth.LoginError as e:
        raise HTTPException(401, str(e))
    token = auth.start_session(db, u)
    audit(db, u.code, "auth", None, f"{u.name} signed in", notify=False)
    db.commit()
    response.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_HOURS * 3600, httponly=True, samesite="lax", secure=_secure(request), path="/")
    return user_out(u)


@auth_api.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    auth.end_session(db, request.cookies.get(auth.COOKIE))
    db.commit()
    response.delete_cookie(auth.COOKIE, path="/")
    return {"ok": True}


@auth_api.get("/auth/me")
def me(actor: auth.Actor | None = Depends(auth.current_actor)):
    if not actor:
        raise HTTPException(401, "Not signed in")
    return {"id": actor.code, "name": actor.name, "roles": list(actor.roles), "gate": actor.gate or ""}


@auth_api.post("/auth/password")
def change_password(body: PasswordIn, request: Request, db: Session = Depends(get_db), actor: auth.Actor = Depends(auth.require_roles(*auth.ROLES))):
    if not actor.user_id:
        raise HTTPException(400, "The API token has no password")
    try:
        auth.authenticate(db, actor.code, body.current)
    except auth.LoginError:
        raise HTTPException(403, "Current password is wrong")
    u = db.get(User, actor.user_id)
    u.password_hash = auth.hash_password(body.new)
    auth.revoke_user_sessions(db, u.id)  # sign out everywhere, then keep this browser signed in
    db.flush()
    token = auth.start_session(db, u)
    audit(db, u.code, "auth", None, f"{u.name} changed their password", notify=False)
    db.commit()
    resp = Response(status_code=204)
    resp.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_HOURS * 3600, httponly=True, samesite="lax", secure=_secure(request), path="/")
    return resp


ADMIN = auth.require_roles("admin")


@auth_api.get("/admin/users")
def list_users(db: Session = Depends(get_db), _: auth.Actor = Depends(ADMIN)):
    return [user_out(u) for u in db.scalars(select(User).order_by(User.code))]


@auth_api.post("/admin/users", status_code=201)
def create_user(body: UserIn, db: Session = Depends(get_db), a: auth.Actor = Depends(ADMIN)):
    u = User(code=body.code.upper(), name=body.name, phone=body.phone, gate=body.gate, roles=_roles(body.roles),
             password_hash=auth.hash_password(body.password), active=body.active)
    db.add(u)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Staff ID {u.code} already exists")
    audit(db, a.code, "staff", u.code, f"Staff account {u.code} ({u.name}) created with roles {u.roles}")
    db.commit()
    return user_out(u)


@auth_api.patch("/admin/users/{code}")
def update_user(code: str, body: UserPatch, db: Session = Depends(get_db), a: auth.Actor = Depends(ADMIN)):
    u = db.scalar(select(User).where(User.code == code.upper()))
    if not u:
        raise HTTPException(404, "Staff account not found")
    changes = body.model_dump(exclude_unset=True)
    if "roles" in changes:
        u.roles = _roles(changes.pop("roles") or [])
    if changes.get("password"):
        u.password_hash = auth.hash_password(changes.pop("password"))
        u.failed_attempts, u.locked_until = 0, None
        auth.revoke_user_sessions(db, u.id)
    if changes.get("active") is False:
        auth.revoke_user_sessions(db, u.id)
    for k, v in changes.items():
        if v is not None or k in ("phone", "gate"):
            setattr(u, k, v)
    audit(db, a.code, "staff", u.code, f"Staff account {u.code} updated ({', '.join(body.model_dump(exclude_unset=True)) or 'no fields'})")
    db.commit()
    return user_out(u)
