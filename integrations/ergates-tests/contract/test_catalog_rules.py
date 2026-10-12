"""The Hermes plugin catalog's admission rules that the plugin's own files can break.

`plugin-catalog/README.md` at the pin lists the rules a catalog entry must
meet. `live/test_catalog_validate.py` runs Hermes's own validator, which
checks the manifest fields, the declared tools and hooks, dependencies, the
install scan and runtime rebinds of Hermes core. The tests here cover what it
does not: the version floor (rule 14), the license and home the manifest
names, and the README's disclosure section (rule 13). They read the plugin's
files; only the pin-version test needs the Hermes checkout.
"""

from __future__ import annotations

import re
import subprocess

import pytest
import yaml

from ergates.policy import BLOCK_UNVERIFIED
from pinned import HERMES_PIN_VERSION, PinnedSource
from plugin_tree import PLUGIN_DIR, copy_tracked_files

REPOSITORY = "https://github.com/middelkampdev/hermes-ergates"
DISCLOSURE_HEADING = "## What this plugin does on your server"


def manifest() -> dict:
    return yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))


def disclosure_section() -> str:
    """The README text from the disclosure heading to the next `## ` heading."""
    readme = (PLUGIN_DIR / "README.md").read_text(encoding="utf-8")
    start = readme.index(DISCLOSURE_HEADING)
    following = re.search(r"^## ", readme[start + len(DISCLOSURE_HEADING):], flags=re.MULTILINE)
    end = start + len(DISCLOSURE_HEADING) + following.start() if following else len(readme)
    return readme[start:end]


def test_requires_hermes_is_the_pinned_release_floor():
    assert manifest().get("requires_hermes") == f">={HERMES_PIN_VERSION}"


def test_the_pin_version_is_the_release_tag_of_the_pinned_commit(hermes: PinnedSource):
    """The floor in `plugin.yaml` follows HERMES_PIN_VERSION, so a pin that moves alone must fail here."""
    tags = subprocess.run(["git", "-C", str(hermes.root), "tag", "--points-at", "HEAD", "--list", "v[0-9]*"],
                          capture_output=True, text=True, check=True).stdout.split()
    if not tags:
        pytest.skip("this checkout has no release tags (a shallow CI checkout)")

    assert f"v{HERMES_PIN_VERSION}" in tags


def test_the_manifest_names_the_license_and_the_home_of_the_plugin():
    license_file = (PLUGIN_DIR.parents[1] / "LICENSE").read_text(encoding="utf-8")

    assert manifest().get("license") == "MIT"
    assert license_file.startswith("MIT License")
    assert manifest().get("homepage") == REPOSITORY


def test_an_install_of_the_plugin_folder_alone_carries_the_license_text(tmp_path):
    """An install of this subdirectory keeps only this folder of the clone
    (`hermes_cli/plugins_cmd_install.py:383` at the pin), so the folder carries its own copy."""
    copy_tracked_files(tmp_path)

    assert (tmp_path / "LICENSE").read_bytes() == (PLUGIN_DIR.parents[1] / "LICENSE").read_bytes()


def test_the_readme_discloses_what_the_plugin_does_on_a_server():
    """Rule 13: network calls, files, background work, reads outside its own data, and what it never does."""
    section = disclosure_section()

    for fact in (
        "`ntfy.server`",  # the one network destination
        "`ERGATES_NTFY_TOKEN`",  # the credential it sends and where it reads it
        "`ergates-sweep`",  # the background thread
        "`sweep.interval_seconds`",  # how often it wakes, and the way to turn it off
        "<hermes root>/ergates/",  # where it writes
        "control.sqlite3",
        "`plugins.enabled`",  # the profile settings it edits
        "`POST /setup`",
        "`POST /profiles/{name}/plugin`",
        "`ERGATES_INSTALL_KIND`",  # what it reads for `health`
        "install metadata",
        "never approves",  # the tool gate
        "fails closed",  # what the gate does when the store or the profile cannot be read
        BLOCK_UNVERIFIED,  # the message the agent sees then: "Ergates could not verify this tool call, ..."
        "telemetry",
        "updates itself",
        "Linux and macOS",  # profile links are symlinks
    ):
        assert fact in section, fact
