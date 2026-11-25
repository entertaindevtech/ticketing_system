"""Acquisition-source classification — the single place these rules live.

Sources: influencer, direct, organic, paid, social, referral (external site), unknown.
Order of precedence (first match wins):
  1. valid influencer referral code               -> influencer
  2. ad click id (gclid, msclkid, dclid)          -> paid
  3. utm_medium in a known group                   -> that group
  4. any other UTM tag present (email, sms, ...)   -> paid   (tagged marketing campaign)
  5. referrer host is a search engine / social site -> organic / social
  6. referrer host is another external site         -> referral
  7. no referrer, or our own host                   -> direct
'unknown' is reserved for bookings that had no visitor session at all.
Referrer and UTM values are client-supplied: fine for analytics, never used for commission.
"""
from urllib.parse import urlsplit

SOURCES = ("influencer", "direct", "organic", "paid", "social", "referral", "unknown")

MEDIUM_GROUPS = {
    "paid": {"cpc", "ppc", "paid", "paidsearch", "paid_search", "paid-search", "paidsocial", "paid_social", "paid-social",
             "display", "cpm", "banner", "cpv", "retargeting", "affiliate"},
    "social": {"social", "social-network", "social_network", "social-media", "social_media", "sm"},
    "organic": {"organic", "seo"},
    "referral": {"referral"},
}
CLICK_IDS = ("gclid", "msclkid", "dclid", "gbraid", "wbraid")
# matched against the registrable part of the host, e.g. "google" in www.google.co.in
SEARCH_ENGINES = {"google", "bing", "yahoo", "duckduckgo", "yandex", "baidu", "ecosia", "brave", "startpage", "qwant"}
SOCIAL_SITES = {"facebook", "instagram", "twitter", "x", "t", "linkedin", "lnkd", "youtube", "whatsapp", "wa", "pinterest",
                "reddit", "tiktok", "snapchat", "threads", "telegram", "quora", "sharechat", "moj"}


def referrer_host(referrer: str | None) -> str | None:
    try:
        host = (urlsplit((referrer or "").strip()).hostname or "").lower()
    except ValueError:
        return None
    host = host[4:] if host.startswith("www.") else host
    return host[:255] or None


def _site(host: str) -> str:
    """'m.facebook.com' -> 'facebook', 'google.co.in' -> 'google', 't.co' -> 't'."""
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "gov", "ac"} and len(parts[-1]) == 2:
        return parts[-3]  # country-code second-level domains
    return parts[-2] if len(parts) >= 2 else host


def classify(*, influencer: bool, utm: dict[str, str | None], click_ids: set[str], ref_host: str | None, own_hosts: set[str]) -> str:
    if influencer:
        return "influencer"
    if click_ids & set(CLICK_IDS):
        return "paid"
    medium = (utm.get("utm_medium") or "").lower()
    for group, mediums in MEDIUM_GROUPS.items():
        if medium in mediums:
            return group
    if any(utm.values()):
        return "paid"
    if not ref_host or ref_host in own_hosts:
        return "direct"
    site = _site(ref_host)
    if site in SEARCH_ENGINES:
        return "organic"
    if site in SOCIAL_SITES or ref_host in {"t.co", "lnkd.in", "wa.me", "youtu.be"}:
        return "social"
    return "referral"
