"""MGM ticketing backend: influencer & regional sales intelligence API, plus the built front-end.

Run: uvicorn app.main:app  (from backend/)
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .api import admin, events, public
from .api_admin import console
from .api_auth import auth_api
from .api_admin_booking import customer_lifecycle, staff_bookings
from .api_booking import booking_api
from .api_shop import shop
from .api_staff import staff_api
from .config import Settings, get_settings
from .db import make_engine, make_sessionmaker
from .geo import GeoLookup
from .geoip_update import start_background_refresh

logging.basicConfig(level=logging.INFO)

ATTRIBUTION = "This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com."


def check_production(s: Settings) -> list[str]:
    """Settings that must never reach a shared environment. staging (which may hold real customer data) needs real
    secrets, PostgreSQL and https; production additionally forbids the demo clock and the simulated payment
    provider. Returns the problems (empty = OK)."""
    from .config import DEV_SECRET
    problems = []
    if s.app_env not in ("staging", "production"):
        return problems
    if not s.database_url.startswith(("postgres://", "postgresql")):
        problems.append("DATABASE_URL must be PostgreSQL")
    if s.app_secret == DEV_SECRET or len(s.app_secret) < 32:
        problems.append("APP_SECRET must be a random secret of at least 32 characters")
    if not s.public_app_url.startswith("https://"):
        problems.append("PUBLIC_APP_URL must be https")
    if s.app_env == "production":
        if s.demo_today:
            problems.append("DEMO_TODAY must not be set")
        if s.simulated_payments:
            problems.append("SIMULATED_PAYMENTS must be off (no verified payment gateway is integrated yet)")
    return problems


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    problems = check_production(settings)
    if problems:
        raise RuntimeError(f"Refusing to start with APP_ENV={settings.app_env}: " + "; ".join(problems))
    @asynccontextmanager
    async def lifespan(_app):
        start_background_refresh(settings.geoip_db_path)
        yield

    app = FastAPI(title="MGM Ticketing API", version="1.0.0", description=f"Influencer & regional sales intelligence. {ATTRIBUTION}", lifespan=lifespan)
    app.state.settings = settings
    app.state.engine = make_engine(settings.database_url)
    app.state.sessionmaker = make_sessionmaker(app.state.engine)
    app.state.geo = GeoLookup(settings.geoip_db_path)

    if settings.cors_origins:  # only needed if the front-end is served from a different origin
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
                           allow_headers=["Content-Type", "X-Admin-Token", "X-Booking-Token", "X-Requested-With", "Idempotency-Key"], allow_credentials=True)

    @app.get("/api/health")
    def health():
        with app.state.engine.connect() as c:
            c.execute(text("SELECT 1"))
        return {"status": "ok", "geoip_available": app.state.geo.available}

    app.include_router(public)
    app.include_router(shop)
    app.include_router(booking_api)
    app.include_router(customer_lifecycle)
    app.include_router(staff_bookings)
    app.include_router(staff_api)
    app.include_router(auth_api)
    app.include_router(console)
    app.include_router(events)
    app.include_router(admin)

    dist = os.path.abspath(settings.frontend_dist)
    if os.path.isdir(dist):
        index = os.path.join(dist, "index.html")
        app.mount("/assets", StaticFiles(directory=os.path.join(dist, "assets")), name="assets")

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "Not found")
            f = os.path.normpath(os.path.join(dist, path))
            if path and f.startswith(dist + os.sep) and os.path.isfile(f):
                return FileResponse(f)
            return FileResponse(index)
    return app


app = create_app()
