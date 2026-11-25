"""Initial catalog and park configuration (ported from src/store.ts seed data).

Used once by migration 0003 and by the test fixtures. After that the catalog lives in PostgreSQL and is edited
through the admin API; changing this file does not change an existing database.
Offer redemption counters start at 0 (the prototype's counters were illustrative).
"""

SETTINGS = {
    "gst": 18, "openTime": "10:30", "closeTime": "18:30", "parkName": "MGM Dizzee World", "phone": "+91 44 2747 2434",
    "email": "bookings@mgmdizzeeworld.com", "defaultCapacity": 4000,
    "saleStart": "2026-11-01", "saleEnd": "2026-12-31",
    # PROVISIONAL: MGM's published FAQ says 25%; the prototype used 10%. MGM must confirm before production.
    "cancellationFeePct": 25, "cancelNoticeDays": 2, "holdMinutes": 15,
}


def _t(id, name, kind, audience, base, description, eligibility):
    return {"id": id, "name": name, "kind": kind, "audience": audience, "basePrice": base, "description": description,
            "eligibility": eligibility, "active": True, "dailyLimit": 400 if kind == "fasttrack" else 3000,
            "validityNote": "Valid on the selected visit date only", "reEntry": False, "restrictions": ""}


TICKETS = [
    _t("ga", "General Adult", "general", "adult", 1099, "Full-day access to all dry & water rides, wave pool and live shows.", "Visitors above 140 cm height"),
    _t("gc", "General Child", "general", "child", 899, "Full-day access to all age-appropriate rides, kids' zone and water play area.", "Height between 90 cm and 140 cm · below 90 cm enter free"),
    _t("fa", "Fast Track Adult", "fasttrack", "adult", 1799, "Skip the regular queue once on every major ride, plus all General ticket benefits.", "Visitors above 140 cm height · limited daily quota"),
    _t("fc", "Fast Track Child", "fasttrack", "child", 1499, "Priority queue access on kids' and family rides, plus all General ticket benefits.", "Height between 90 cm and 140 cm · limited daily quota"),
]

ADDONS = [
    {"id": "food", "name": "Dizzee Meal Combo", "description": "Veg/non-veg meal, dessert and a soft drink at any food court.", "price": 349, "icon": "food", "tag": "Bestseller"},
    {"id": "locker", "name": "Locker Reservation", "description": "Pre-booked medium locker near the water zone, valid all day.", "price": 199, "icon": "locker"},
    {"id": "swim", "name": "Swimwear Package", "description": "Mandatory nylon swimwear for water rides – collect at counter.", "price": 299, "icon": "swim"},
    {"id": "vr", "name": "VR Coaster Experience", "description": "Premium virtual-reality coaster session (1 ride).", "price": 249, "icon": "vr", "tag": "Premium"},
    {"id": "photo", "name": "Digital Photo Pass", "description": "Unlimited ride photos delivered to your phone.", "price": 399, "icon": "camera"},
    {"id": "cabana", "name": "Wave Pool Cabana", "description": "Private shaded cabana for up to 6 guests with towels.", "price": 1499, "icon": "cabana", "tag": "Premium"},
]

OFFER_DEFAULTS = {
    "description": "", "theme": "sunset", "categories": ["ga"], "bookingStart": "2026-10-15", "bookingEnd": "2026-12-31",
    "visitStart": "2026-11-01", "visitEnd": "2026-12-31", "weekdays": [], "dates": [], "minQty": 1, "value": 0, "buyX": 0, "getY": 0,
    "packagePrice": 0, "packageContents": {}, "maxRedemptions": 1000, "redemptions": 0, "coupon": "", "terms": "", "priority": 5,
    "status": "active", "featured": False, "requiresId": "",
}


def _o(**o):
    return {**OFFER_DEFAULTS, **o, "redemptions": 0}


OFFERS = [
    _o(id="o-b4g2", name="Buy 4 Get 2 Free", type="bxgy", theme="sunset", featured=True, priority=1,
       description="Bring the whole gang! Pay for 4 General Adult tickets and 2 more come free.",
       categories=["ga"], buyX=4, getY=2, weekdays=[1, 2, 3, 4, 5], visitStart="2026-11-20", visitEnd="2026-12-19",
       maxRedemptions=500, terms="Valid Monday to Friday only.\nAll 6 visitors must enter together.\nNot combinable with coupon codes."),
    _o(id="o-student", name="Student Offer", type="percent", theme="ocean", priority=3, value=25,
       description="25% off General Adult tickets for college students with a valid ID.",
       categories=["ga"], weekdays=[1, 2, 3, 4], visitEnd="2026-12-18", requiresId="Valid college student ID card",
       maxRedemptions=1000, terms="Student ID must be shown at the entry gate.\nValid Monday to Thursday.\nOne ticket per student ID."),
    _o(id="o-weekend", name="Weekend Special", type="flat", theme="berry", priority=2, value=250, featured=True,
       description="Flat ₹250 off every General Adult ticket on Saturdays and Sundays.",
       categories=["ga"], weekdays=[0, 6], maxRedemptions=800,
       terms="Valid only on Saturdays and Sundays.\nMinimum 2 tickets per booking.", minQty=2),
    _o(id="o-family", name="Family Package", type="package", theme="mint", priority=2, featured=True,
       description="2 Adults + 2 Children General tickets at one combined price.",
       categories=["ga", "gc"], packageContents={"ga": 2, "gc": 2}, packagePrice=3499, maxRedemptions=600,
       terms="Package includes exactly 2 adults and 2 children.\nChildren must be between 90 and 140 cm.\nNon-transferable."),
    _o(id="o-xmas", name="Christmas Carnival Fast Track", type="percent", theme="festive", priority=1, value=20,
       description="20% off Fast Track Adult tickets on carnival days.", categories=["fa"],
       dates=["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-31"], visitStart="2026-12-24", visitEnd="2026-12-31",
       maxRedemptions=300, terms="Valid on 24, 25, 26 and 31 December only.\nSubject to daily Fast Track quota."),
    _o(id="c-mgm30", name="MGM30 Coupon", type="percent", theme="night", coupon="MGM30", value=30, minQty=2, priority=4,
       description="30% off eligible regular General tickets.", categories=["ga", "gc"], maxRedemptions=2000,
       terms="Minimum 2 General tickets.\nNot valid on offer tickets or Fast Track.\nOne coupon per booking."),
    _o(id="c-fast150", name="Fast Friday", type="flat", theme="ocean", coupon="FASTFRI", value=150, minQty=1, priority=5,
       description="₹150 off every Fast Track ticket on Fridays.", categories=["fa", "fc"], weekdays=[5], maxRedemptions=400,
       terms="Valid for Friday visits only."),
    _o(id="c-dizzee10", name="DIZZEE10 Coupon", type="percent", theme="sunset", coupon="DIZZEE10", value=10, priority=6,
       description="10% off all regular tickets.", categories=["ga", "gc", "fa", "fc"], status="paused", maxRedemptions=500,
       terms="Paused by marketing team."),
    _o(id="o-nye", name="New Year Countdown Night", type="package", theme="festive", status="draft", priority=1,
       description="Fast Track Adult + dinner buffet for New Year's Eve.", categories=["fa"], packageContents={"fa": 1}, packagePrice=2499,
       dates=["2026-12-31"], visitStart="2026-12-31", visitEnd="2026-12-31", maxRedemptions=200, terms="Draft – pending approval."),
]

DATES = {
    "2026-11-24": {"enabled": False, "note": "Annual ride maintenance"},
    "2026-12-03": {"blackout": True, "note": "Private corporate event"},
    "2026-12-25": {"priceAdj": 25, "note": "Christmas Day"},
    "2026-12-31": {"priceAdj": 30, "note": "New Year's Eve"},
}
