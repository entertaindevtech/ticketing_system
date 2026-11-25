"""Staff authentication and role checks (interim: the shared ADMIN_API_TOKEN; replaced by accounts in milestone E)."""
from dataclasses import dataclass

from fastapi import Depends, Request

from .api import require_admin


@dataclass
class Actor:
    code: str
    name: str
    roles: tuple[str, ...]
    gate: str | None = None


def require_roles(*roles: str):
    def dep(request: Request, _=Depends(require_admin)) -> Actor:
        return Actor(code="ADMIN", name="Admin", roles=("admin",))
    return dep
