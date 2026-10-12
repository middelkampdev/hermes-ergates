"""Periodic maintenance: one sweep of the control store, and ``python -m ergates.flush``.

Two jobs no hook does, because the hooks fire only on an event and Hermes
runs no timer for a plugin:

1. **Send due pushes.** A push whose first attempt failed, or whose process
   died mid-send, stays due in the control store's outbox until a sweep
   sends it (:class:`~ergates.delivery.DeliveryWorker`).
2. **Apply retention and expiry.** Every service has an ``expire`` or a
   ``prune``; nothing calls them from inside a hook (04 section 8; 11
   sections 4.1-4.3).

``hermes serve`` runs :func:`sweep_once` on its own thread every
``sweep.interval_seconds``, two minutes by default (:mod:`ergates.sweep`);
``python -m ergates.flush`` runs it once, by hand. The ntfy credentials are the install-wide push settings in the Hermes
root's ``config.yaml`` (:mod:`ergates.settings`), the same ones every hook
reads, so **no token ever appears on a command line, in a process listing,
or in this module's output**. The only argument is ``--quiet``.

Inside the Hermes runtime the reminder sweep asks Hermes cron
(:class:`~ergates.hermes_adapter.HermesCron`) whether each receipt's job
still exists, so a job deleted in the Routines screen drops its receipt.
Without Hermes, ``HermesCron`` answers "could not tell" and only the 30-day
idle rule applies.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional

from .attention import AttentionService
from .delivery import DeliveryWorker, ntfy_settings, send_ntfy
from .hermes_adapter import HermesCron
from .paths import hermes_root, store_path
from .proposals import ProposalService
from .reminders import CronPort, ReminderService, UnavailableCron
from .settings import load_settings
from .store import ControlStore, root_run_would_break

logger = logging.getLogger("ergates.flush")


def flush_once(
    root: Path,
    settings: Mapping[str, str],
    *,
    now: Optional[float] = None,
    publish: Callable[[Dict[str, Any]], None] = send_ntfy,
    cron: Optional[CronPort] = None,
    clock: Callable[[], float] = time.time,
) -> Dict[str, int]:
    """Run one expiry pass, one retention pass and one delivery pass. Counts only, never content.

    ``root`` is the Hermes root; the store is ``paths.store_path(root)``.
    Expiry runs before delivery, so an approval that timed out is cancelled,
    never pushed. The delivery pass is skipped (not an error) when
    ``ntfy.server`` or ``ntfy.topic`` is unset: a deployment without push
    still gets its retention sweep.

    ``cron`` is optional and, when given, lets the reminder sweep drop
    receipts whose cron job has been deleted natively; without it the sweep
    applies only the 30-day idle rule (:class:`~ergates.reminders.UnavailableCron`).

    Expiry and retention run on one timestamp, ``now`` (default: ``clock()``
    at the start). The delivery pass runs on ``clock`` itself, so each lease
    counts from its own claim, however long the passes before it took.
    """
    moment = clock() if now is None else now
    frozen = lambda: moment  # noqa: E731 - one timestamp for expiry and retention
    store = ControlStore(store_path(root))
    try:
        attention = AttentionService(store, clock=frozen)
        counts = {
            "retried": 0,
            # Expiries are reported separately from deletions: an expired approval
            # becomes a terminal record with a seven-day audit window, it is not
            # removed here, and an operator reading the log line should be able to
            # tell "N approvals timed out unanswered" from "N records aged out".
            "expired_notifications": attention.expire(moment),
            "pruned_notifications": attention.prune(moment),
            "pruned_proposals": ProposalService(store, clock=frozen).prune(moment),
            "pruned_reminders": ReminderService(store, cron or UnavailableCron(), clock=frozen).prune(moment),
        }
        ntfy = ntfy_settings(settings)
        if ntfy is not None:
            counts["retried"] = DeliveryWorker(store, publish, ntfy, clock=clock).run_due()
        else:
            logger.info("ergates.flush: ntfy.server/ntfy.topic unset; delivery pass skipped")
    finally:
        store.close()
    return counts


def sweep_once(root: Path) -> Dict[str, int]:
    """One sweep of the Hermes root ``root`` with its install-wide push settings and Hermes cron.

    What ``python -m ergates.flush`` runs once and the ``hermes serve``
    thread runs every interval. Every write goes through the store, so as
    root on a Hermes root another user owns the pass raises ``StoreError``
    before it creates anything (``store.root_run_would_break``).
    """
    try:
        settings = load_settings(root)
    except Exception as exc:
        # A config.yaml a YAML parser refuses must not stop expiry, retention
        # or pruning (settings.py's own invariant, mirrored from
        # tool.py's _delivery_worker): push is off for this run, everything
        # else still runs, and only the exception class name is logged --
        # a YAML parser error can quote the offending line.
        logger.warning("ergates.flush: config.yaml unreadable (%s); push skipped this run", type(exc).__name__)
        settings = {}
    return flush_once(root, settings, cron=HermesCron())


def main(argv: Optional[list] = None) -> int:
    """CLI entry point. Prints one line of counts; exits non-zero only on a hard failure."""
    parser = argparse.ArgumentParser(
        prog="python -m ergates.flush",
        description=(
            "Send due ntfy pushes and apply retention to the ergates control store. "
            "Credentials are read from the Hermes root's config.yaml, never from arguments."
        ),
    )
    parser.add_argument(
        "--quiet", action="store_true", help="Suppress the summary line (exit code only).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    root = hermes_root()
    if not root.exists():
        print(f"ergates.flush: no Hermes home at {root}", file=sys.stderr)
        return 2
    if root_run_would_break(root):
        print(
            f"ergates.flush: refusing to run as root; {root} belongs to another user, and a root run can "
            "leave store files that user cannot open. Run it as that user "
            "(docker compose exec -u hermes ...).",
            file=sys.stderr,
        )
        return 2
    counts = sweep_once(root)
    if not args.quiet:
        print(
            "ergates.flush: retried={retried} expired_notifications={expired_notifications} "
            "pruned_notifications={pruned_notifications} pruned_proposals={pruned_proposals} "
            "pruned_reminders={pruned_reminders}".format(**counts)
        )
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through main() in tests
    raise SystemExit(main())
