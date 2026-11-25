"""Operational commands (run from backend/):

  python -m app.cli create-user ADM001 "Park Admin" --roles admin
      Creates a staff account. The password is read from the MGM_NEW_PASSWORD environment variable if set,
      otherwise prompted (never passed on the command line, where it would land in shell history).
  python -m app.cli reset-password ADM001
  python -m app.cli seed-demo
      Demo/staging only (refused when APP_ENV=production): demo staff accounts and sample bookings.
"""
import argparse
import getpass
import os
import sys

from sqlalchemy import select

from . import auth
from .config import get_settings
from .db import make_engine, make_sessionmaker
from .models import User


def _password() -> str:
    pw = os.environ.get("MGM_NEW_PASSWORD") or getpass.getpass("Password (min %d chars): " % auth.MIN_PASSWORD_LEN)
    if not os.environ.get("MGM_NEW_PASSWORD") and getpass.getpass("Repeat: ") != pw:
        sys.exit("Passwords do not match")
    return pw


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("code")
    c.add_argument("name")
    c.add_argument("--roles", default="admin", help="comma-separated: " + ",".join(auth.ROLES))
    c.add_argument("--gate", default=None)
    r = sub.add_parser("reset-password")
    r.add_argument("code")
    sub.add_parser("seed-demo")
    a = p.parse_args(argv)
    s = get_settings()
    db = make_sessionmaker(make_engine(s.database_url))()
    if a.cmd == "create-user":
        roles = [x.strip() for x in a.roles.split(",") if x.strip()]
        if not roles or any(x not in auth.ROLES for x in roles):
            sys.exit(f"roles must be from {auth.ROLES}")
        if db.scalar(select(User).where(User.code == a.code.upper())):
            sys.exit(f"{a.code} already exists")
        db.add(User(code=a.code.upper(), name=a.name, roles=",".join(roles), gate=a.gate, password_hash=auth.hash_password(_password())))
        db.commit()
        print(f"Created {a.code.upper()} ({', '.join(roles)})")
    elif a.cmd == "reset-password":
        u = db.scalar(select(User).where(User.code == a.code.upper()))
        if not u:
            sys.exit("No such account")
        u.password_hash, u.failed_attempts, u.locked_until = auth.hash_password(_password()), 0, None
        auth.revoke_user_sessions(db, u.id)
        db.commit()
        print(f"Password reset for {u.code}; existing sessions signed out")
    elif a.cmd == "seed-demo":
        if s.app_env == "production":
            sys.exit("seed-demo is refused when APP_ENV=production")
        from .demo_seed import seed_demo
        print(seed_demo(db, s))


if __name__ == "__main__":
    main()
