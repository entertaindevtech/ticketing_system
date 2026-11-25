"""Runtime settings, all from environment variables (see backend/.env.example)."""
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


DEV_SECRET = "dev-only-secret-not-for-production-use-0000"


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", "sqlite:///./mgm_dev.db"))
    # Public URL customers land on; referral URLs are built from it (e.g. https://book.example.com).
    public_app_url: str = field(default_factory=lambda: os.environ.get("PUBLIC_APP_URL", "http://localhost:8000").rstrip("/"))
    admin_api_token: str = field(default_factory=lambda: os.environ.get("ADMIN_API_TOKEN", ""))
    attribution_model: str = field(default_factory=lambda: os.environ.get("ATTRIBUTION_MODEL", "first_click"))
    attribution_window_days: int = field(default_factory=lambda: _int("ATTRIBUTION_WINDOW_DAYS", 30))
    max_bookings_per_session: int = field(default_factory=lambda: _int("MAX_BOOKINGS_PER_SESSION", 5))
    # lifetime of an anonymous visitor session (re-created after this; extended while an influencer attribution is live)
    visitor_session_days: int = field(default_factory=lambda: _int("VISITOR_SESSION_DAYS", 30))
    # ticket_net_ex_gst = ticket revenue after discounts, excluding GST and add-ons (default)
    # total_ex_gst      = everything the customer paid except GST (tickets + add-ons)
    commission_basis: str = field(default_factory=lambda: os.environ.get("COMMISSION_BASIS", "ticket_net_ex_gst"))
    geoip_db_path: str = field(default_factory=lambda: os.environ.get("GEOIP_DB_PATH", "./data/GeoLite2-City.mmdb"))
    # Number of trusted reverse proxies in front of the app (Railway edge = 1). 0 = use the socket peer address.
    trusted_proxy_hops: int = field(default_factory=lambda: _int("TRUSTED_PROXY_HOPS", 1))
    cors_origins: list[str] = field(default_factory=lambda: [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()])
    frontend_dist: str = field(default_factory=lambda: os.environ.get("FRONTEND_DIST", "../dist"))
    # development | staging | production. production refuses unsafe settings at start-up (see main.check_production).
    app_env: str = field(default_factory=lambda: os.environ.get("APP_ENV", "development").strip().lower())
    # Pins the park's "today" (YYYY-MM-DD) for demos and tests. Never set in production.
    demo_today: str | None = field(default_factory=lambda: os.environ.get("DEMO_TODAY") or None)
    # Signs ticket QR codes and customer booking-access links (HMAC-SHA256). Required (>= 32 chars) in production;
    # rotating it invalidates every issued QR code and link.
    app_secret: str = field(default_factory=lambda: os.environ.get("APP_SECRET", DEV_SECRET))
    # Demo payment provider. No money moves. Must be off in production until a verified gateway is integrated.
    simulated_payments: bool = field(default_factory=lambda: _bool("SIMULATED_PAYMENTS", True))


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def get_settings() -> Settings:
    return Settings()
