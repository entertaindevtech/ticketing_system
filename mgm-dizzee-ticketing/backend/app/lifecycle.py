"""Booking lifecycle after payment: cancellation requests, refunds, modifications (milestone C)."""
from sqlalchemy.orm import Session

from .models import Booking


def dto_extras(db: Session, b: Booking) -> dict:
    return {}
