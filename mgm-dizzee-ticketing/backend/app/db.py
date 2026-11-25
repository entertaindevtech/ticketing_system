from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    # Railway provides postgres:// / postgresql:// URLs; we use the psycopg 3 driver.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def make_engine(url: str):
    url = normalize_url(url)
    kw = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    return create_engine(url, **kw)


def make_sessionmaker(engine):
    return sessionmaker(bind=engine, expire_on_commit=False)
