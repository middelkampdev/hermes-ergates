"""The service names behind the app's restart line.

Hermes installs no service for `hermes serve`, so the name of the unit that
runs it depends on the setup. The Finish screen's restart line
(`RESTART_LINES` in `apps/mobile/src/features/server/finish-view.ts`) names the
two units Hermes's own code knows: `hermes-dashboard` and `hermes-serve`. These
tests keep those names equal to the pin.
"""

from __future__ import annotations

from pathlib import Path

from pinned import PinnedSource

DASHBOARD = "hermes_cli/main_dashboard.py"
FLEET = "hermes_cli/update_cmd_fleet.py"
FINISH_VIEW = Path(__file__).resolve().parents[3] / "apps/mobile/src/features/server/finish-view.ts"


def test_the_app_restart_line_names_both_services() -> None:
    assert "'Hermes service: systemctl --user restart hermes-dashboard (or hermes-serve)'," in FINISH_VIEW.read_text(encoding="utf-8")


def test_the_dashboard_service_is_hermes_dashboard(hermes: PinnedSource) -> None:
    # hermes_cli/main_dashboard.py:82
    assert hermes.assigned(DASHBOARD, "_DASHBOARD_SYSTEMD_UNIT") == "hermes-dashboard.service"


def test_hermes_update_restarts_a_hermes_serve_service_and_its_profile_units(hermes: PinnedSource) -> None:
    # hermes_cli/update_cmd_fleet.py:744-745, in `_is_hermes_gateway_unit`
    assert hermes.lines(FLEET, 744, 745) == (
        '        or unit == "hermes-serve.service"\n'
        '        or unit.startswith("hermes-serve-")'
    )
