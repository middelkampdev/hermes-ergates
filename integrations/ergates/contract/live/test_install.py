"""``python -m ergates.install`` against the pinned Hermes, with the templates ``deploy/`` ships.

The plugin is installed once at the root and enabled in every profile,
because Hermes loads a user plugin only from the active home and only when
that home enables it. A root the installer set up while Hermes was at the
previous pin keeps working when Hermes v0.21.6 starts on it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from ergates.hermes_adapter import plugin_enabled, profile_names
from ergates.install import install_templates, main, source_templates
from ergates.paths import store_path, templates_dir
from ergates.reminders import ReminderService
from ergates.store import SCHEMA_VERSION as CURRENT_SCHEMA_VERSION
from ergates.store import ControlStore
from ergates.templates import load_template

SHIPPED = Path(__file__).resolve().parents[4] / "deploy" / "templates"
PLUGIN_DIR = Path(__file__).resolve().parents[2]
API = "/api/plugins/ergates"
# DEFAULT_CONFIG["_config_version"] at the previous pin, Hermes d76856cc (v0.21.6 has 50). Hermes's
# save_config always writes it, so every config.yaml the installer saved there carries it.
OLD_PIN_CONFIG_VERSION = 43
PREPARED_PROFILE = "anna"


def test_install_enables_the_plugin_in_every_profile_and_installs_the_shipped_templates(root, make_profile, capsys):
    make_profile("pia")
    make_profile("quin")

    main(["--templates", str(SHIPPED)])

    names = profile_names()
    assert {"default", "pia", "quin"} <= set(names)
    # Other live test modules share this session-scoped root and deliberately leave a broken
    # profile behind (a plugins/ergates folder that is not a link, to test enable_plugin's own
    # refusal), so this checks only the profiles this test controls, not every name in the root.
    assert plugin_enabled("default") and plugin_enabled("pia") and plugin_enabled("quin")
    assert (root / "profiles" / "pia" / "plugins" / "ergates").is_symlink()
    installed = sorted(path.name for path in templates_dir(root).glob("*.json"))
    assert installed == sorted(path.name for path in SHIPPED.glob("*.json"))
    for path in SHIPPED.glob("*.json"):
        assert load_template(templates_dir(root), path.stem)["template_id"] == path.stem

    capsys.readouterr()  # drain the install run's own output; --check must report its own facts
    check_code = main(["--templates", str(SHIPPED), "--check"])
    lines = capsys.readouterr().out.splitlines()

    shipped_ids = sorted(path.stem for path in SHIPPED.glob("*.json"))
    assert lines[0] == f"ergates.install: templates=installed ({', '.join(shipped_ids)})"
    profile_states = dict(
        re.match(r"ergates\.install: profile=(\S+) plugin=(.+)", line).groups() for line in lines[1:]
    )
    assert profile_states["default"] == "enabled"
    assert profile_states["pia"] == "enabled"
    assert profile_states["quin"] == "enabled"
    # A broken profile some other live test module left behind (see above) still makes --check
    # answer 1; the exit code is derived from --check's own lines, not asserted as a fixed value.
    assert check_code == (0 if all(state == "enabled" for state in profile_states.values()) else 1)


def test_every_shipped_template_names_only_toolsets_hermes_knows(root):
    """A misspelled toolset would be pinned as is, and the tool gate would then block every tool it meant."""
    from hermes_cli.plugins import PluginManager
    from toolsets import validate_toolset

    # The live toolset registry knows a plugin's toolsets only once some plugin manager has
    # actually loaded it (as every real deployment's gateway does for an enabled profile); load
    # it here so this check does not depend on another live test module running first.
    PluginManager(scope_key=str(root)).discover_and_load()

    shipped = [load_template(SHIPPED, path.stem) for path in sorted(SHIPPED.glob("*.json"))]
    assert shipped
    unknown = {(t["template_id"], name) for t in shipped for name in t["enabled_toolsets"] if not validate_toolset(name)}
    assert unknown == set()


class _CronThatKnowsNoJob:
    """A cron port for filling the store outside Hermes: it hands out a job id and knows no job."""

    def create_job(self, profile: str, *, schedule: str, prompt: str, name: str) -> dict:
        return {"id": "job-made-on-the-old-pin", "name": name}

    def get_job(self, profile: str, job_id: str) -> dict | None:
        return None

    def find_job_ids_by_name(self, profile: str, name: str) -> list[str]:
        return []


@pytest.fixture
def prepared_root(tmp_path) -> Path:
    """A Hermes root as ``ergates.install`` left it on the previous pin, built file by file.

    The plugin is linked into the root and into one named profile, each
    ``config.yaml`` holds ``plugins.enabled: [ergates]`` at that pin's config
    version, the shipped templates are installed, and ``control.sqlite3``,
    made by the current store code, holds one reminder receipt.
    """
    root = tmp_path / "hermes"
    (root / "plugins").mkdir(parents=True)
    plugin = root / "plugins" / "ergates"
    plugin.symlink_to(PLUGIN_DIR, target_is_directory=True)
    old_config = {"_config_version": OLD_PIN_CONFIG_VERSION, "plugins": {"enabled": ["ergates"]}}
    # Not the installer's: the live suite's guard against lazy `uv pip install` (see conftest.py).
    (root / "config.yaml").write_text(yaml.safe_dump({**old_config, "security": {"allow_lazy_installs": False}}),
                                      encoding="utf-8")
    home = root / "profiles" / PREPARED_PROFILE
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "ergates").symlink_to(plugin, target_is_directory=True)
    (home / "config.yaml").write_text(yaml.safe_dump(old_config), encoding="utf-8")
    install_templates(source_templates(SHIPPED), templates_dir(root))
    ReminderService(ControlStore(store_path(root)), _CronThatKnowsNoJob()).create(
        PREPARED_PROFILE, "0 8 * * 1", "Europe/Amsterdam", "Water the plants.", request_id="old-pin-1", label="Plants")
    return root


@pytest.fixture
def web_on_prepared_root(serve_hermes, prepared_root):
    """A dashboard Hermes v0.21.6 started on ``prepared_root``."""
    return serve_hermes(prepared_root)


def reminder_round_trip(web, headers: dict) -> str:
    """Posts one new reminder for the prepared profile; the state of its receipt, else the error answer."""
    reply = web.post(f"{API}/reminders", headers=headers, json={
        "profile": PREPARED_PROFILE, "schedule": "0 9 * * *", "timezone": "Europe/Amsterdam",
        "prompt": "Check the unpaid invoices.", "request_id": "v0216-1", "label": "Invoices"})
    return reply.json().get("receipt", {}).get("state") or f"{reply.status_code} {reply.text}"


def test_a_root_set_up_on_the_old_pin_keeps_working(web_on_prepared_root, token_headers):
    health = web_on_prepared_root.get(f"{API}/health", headers=token_headers)
    assert health.status_code == 200
    assert health.json()["schema_version"] == CURRENT_SCHEMA_VERSION
    assert reminder_round_trip(web_on_prepared_root, token_headers) == "created"


def test_a_profile_the_old_installer_enabled_still_loads_the_plugin(web_on_prepared_root, prepared_root,
                                                                     token_headers):
    """The enable route answers with Hermes's own discovery in that profile, and has nothing to change."""
    config = prepared_root / "profiles" / PREPARED_PROFILE / "config.yaml"
    before = config.read_bytes()

    reply = web_on_prepared_root.post(f"{API}/profiles/{PREPARED_PROFILE}/plugin", headers=token_headers)

    assert (reply.status_code, reply.json()) == (200, {"profile": PREPARED_PROFILE, "enabled": True})
    assert config.read_bytes() == before
    with ControlStore(store_path(prepared_root)).read() as conn:
        assert [row[0] for row in conn.execute("SELECT request_id FROM reminder_receipts")] == ["old-pin-1"]
