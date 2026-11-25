"""Demo / staging data (python -m app.cli seed-demo). Refused when APP_ENV=production.

Creates one staff account per role with a freshly generated password (printed once, never stored in plain text
or shipped in the front-end), plus sample website and counter bookings made through the real booking engine so
that inventory, tickets, payments, analytics and the gate all behave exactly as in production.
"""
import random
import secrets

from sqlalchemy import select

from . import auth, bookings, pricing
from .models import Booking, User

DEMO_STAFF = [
    ("ADM001", "Park Administrator", "admin", None),
    ("FIN001", "Finance Desk", "finance", None),
    ("CNT001", "Ticket Counter 1", "counter", None),
    ("MKT001", "Marketing Team", "marketing", None),
    ("STF1024", "Arun Kumar", "gate", "Main Gate A"),
    ("STF1031", "Priya Lakshmi", "gate", "Main Gate B"),
]
NAMES = ["Karthik R", "Divya Kumar", "Suresh Iyer", "Anitha Raj", "Vignesh Menon", "Meena Pillai", "Rahul Reddy", "Sneha Rao",
         "Arjun S", "Lakshmi Krishnan", "Praveen Murugan", "Kavya Natarajan"]


def seed_demo(db, cfg, bookings_per_day: int = 3, days: int = 14) -> str:
    lines = []
    for code, name, role, gate in DEMO_STAFF:
        if db.scalar(select(User).where(User.code == code)):
            lines.append(f"  {code:8} exists (unchanged)")
            continue
        pw = secrets.token_urlsafe(9)
        db.add(User(code=code, name=name, roles=role, gate=gate, password_hash=auth.hash_password(pw + "-demo")))
        lines.append(f"  {code:8} {role:9} password: {pw}-demo")
    db.commit()
    if db.scalar(select(Booking.id).where(Booking.origin == "demo_seed")):
        return "Staff accounts:\n" + "\n".join(lines) + "\nDemo bookings already present."
    rnd = random.Random(20261119)
    today = pricing.today_ist(cfg.demo_today)
    made = 0
    for d in range(days):
        vd = pricing.add_days(today, d)
        for i in range(bookings_per_day):
            cart = {"tickets": {"ga": rnd.randint(1, 3)}, "offers": {}, "addons": {}, "coupon": ""}
            if rnd.random() < 0.5:
                cart["tickets"]["gc"] = rnd.randint(1, 2)
            if rnd.random() < 0.4:
                cart["addons"]["food"] = rnd.randint(1, 3)
            phone = f"9{rnd.randint(100000000, 999999999)}"
            try:
                with db.begin_nested():
                    counter = rnd.random() < 0.25
                    b, _ = bookings.create_booking(db, cfg, visit_date=vd, cart=cart, customer={"name": rnd.choice(NAMES), "phone": phone},
                                                   channel="counter" if counter else "web", created_by="CNT001" if counter else None)
                    b.origin = "demo_seed"
                    p = bookings.start_payment(db, b, "counter" if counter else "simulated", "Cash" if counter else "UPI")
                    bookings.capture_payment(db, cfg, payment_id=p.id, provider=p.provider, provider_payment_id=f"demo_{p.id}",
                                             amount=p.amount, event_id=f"demo:{p.id}")
                made += 1
            except bookings.BookingError:
                continue  # closed / blackout dates are skipped, as a real customer would be refused
    db.commit()
    return "Staff accounts (store these passwords now; they are not shown again):\n" + "\n".join(lines) + f"\nDemo bookings created: {made}"
