from logging.config import fileConfig

from alembic import context

from app.config import get_settings
from app.db import Base, make_engine
from app import models  # noqa: F401  (registers tables on Base.metadata)

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

url = config.get_main_option("sqlalchemy.url") or get_settings().database_url


def run_migrations_offline():
    from app.db import normalize_url
    context.configure(url=normalize_url(url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    engine = make_engine(url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=connection.dialect.name == "sqlite")
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
