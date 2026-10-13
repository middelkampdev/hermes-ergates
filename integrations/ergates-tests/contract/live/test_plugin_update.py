"""Replacing the plugin on a running ``hermes serve`` through its REST install route, the way the app will.

``plugin_two_commits`` is a copy of ``plugin_monorepo`` with a second commit, so one server can install the
plugin at the first commit and update it to the second. What these tests pin about Hermes:

* A plugin that is turned on cannot be replaced over REST. Hermes asks for consent to the Python dependencies of
  the folder it replaces when that folder is among the enabled plugins, and without a terminal the answer is a
  refusal. Turn the plugin off first, then install with ``force``.
* A failed forced install leaves the installed tree as it was, and the plugin turned off.
* The routes a server has mounted keep their old code after an update. ``GET /health`` reads Hermes's install
  record at each call, so ``install.commit`` is the new commit while ``install.loaded_commit``, read when the
  ``ergates`` package was imported, is the commit the running code came from.
* Routes that fail to mount leave behind the package modules their ``api.py`` imported. Routes Hermes mounts
  later, from another install, run over those modules, and ``install.loaded_commit`` names the commit they came
  from.

Each test starts its own server (``web_without_plugin``): Hermes mounts plugin routes per process.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

import pytest

from app_messages import hermes_plugin_messages
from plugin_tree import NO_HOOKS

API = "/api/plugins/ergates"
HUB = "/api/dashboard/plugins/hub"
AGENT_PLUGINS = "/api/dashboard/agent-plugins"
INSTALL = f"{AGENT_PLUGINS}/install"
NOT_IN_THE_REPOSITORY = "0" * 40


@dataclass(frozen=True)
class TwoCommits:
    """A repository with the plugin at two commits: ``identifier`` installs it, ``first`` and ``second`` are the refs."""

    identifier: str
    first: str
    second: str


@pytest.fixture(scope="module")
def plugin_two_commits(tmp_path_factory, plugin_monorepo) -> TwoCommits:
    """A clone of ``plugin_monorepo`` whose second commit adds a line to the plugin's README.

    The shared repository stays as it is for the other tests. The clone keeps the first commit, and a README
    line keeps the tree ``safe`` for Hermes's install scan.
    """
    path = tmp_path_factory.mktemp("plugin-update-repo")
    git = ["git", *NO_HOOKS, "-C", str(path), "-c", "user.name=Ergates contract",
           "-c", "user.email=contract@ergates.invalid", "-c", "commit.gpgsign=false"]
    subprocess.run(["git", *NO_HOOKS, "clone", "-q", str(plugin_monorepo.path), str(path)], check=True)
    readme = path / plugin_monorepo.subdir / "README.md"
    readme.write_text(readme.read_text(encoding="utf-8") + "\nA second commit for the update tests.\n",
                      encoding="utf-8")
    subprocess.run([*git, "commit", "-q", "-a", "-m", "Ergates plugin, second commit"], check=True)
    second = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    assert second != plugin_monorepo.sha
    return TwoCommits(identifier=f"{path.as_uri()}#{plugin_monorepo.subdir}", first=plugin_monorepo.sha, second=second)


@pytest.fixture(scope="module")
def plugin_broken_routes(tmp_path_factory, plugin_monorepo) -> TwoCommits:
    """A clone of ``plugin_monorepo`` whose second commit makes ``dashboard/api.py`` raise once it has imported
    the ``ergates`` package, the way a broken update did on a real server: Hermes mounts no routes, and the
    package modules the file imported stay in the server's process."""
    path = tmp_path_factory.mktemp("plugin-broken-repo")
    git = ["git", *NO_HOOKS, "-C", str(path), "-c", "user.name=Ergates contract",
           "-c", "user.email=contract@ergates.invalid", "-c", "commit.gpgsign=false"]
    subprocess.run(["git", *NO_HOOKS, "clone", "-q", str(plugin_monorepo.path), str(path)], check=True)
    api = path / plugin_monorepo.subdir / "dashboard" / "api.py"
    last_import = "from ergates.sweep import SWEEP_INTERVAL_SECONDS, Sweep  # noqa: E402\n"
    text = api.read_text(encoding="utf-8")
    assert last_import in text
    api.write_text(text.replace(last_import, last_import + 'raise RuntimeError("these routes do not mount")\n'),
                   encoding="utf-8")
    subprocess.run([*git, "commit", "-q", "-a", "-m", "Ergates plugin whose routes do not mount"], check=True)
    broken = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    return TwoCommits(identifier=f"{path.as_uri()}#{plugin_monorepo.subdir}", first=plugin_monorepo.sha,
                      second=broken)


def install(web, headers: dict, repo: TwoCommits, ref: str, *, force: bool):
    """What the app sends to install the plugin at ``ref``; the whole answer."""
    reply = web.post(INSTALL, json={"identifier": repo.identifier, "ref": ref, "enable": True, "force": force},
                     headers=headers)
    print(f"POST {INSTALL} (ref {ref}, force {force}) -> {reply.status_code}\n{json.dumps(reply.json(), indent=2)}")
    return reply


def turn(web, headers: dict, action: str) -> None:
    """``enable`` or ``disable`` the plugin through the route the app uses."""
    reply = web.post(f"{AGENT_PLUGINS}/ergates/{action}", headers=headers)
    assert (reply.status_code, reply.json()["ok"]) == (200, True), reply.text


def runtime_status(web, headers: dict) -> str | None:
    """The plugin's ``runtime_status`` in the plugin list the app reads, or None when the list has no row."""
    reply = web.get(HUB, headers=headers)
    assert reply.status_code == 200, reply.text
    return next((row["runtime_status"] for row in reply.json()["plugins"] if row["name"] == "ergates"), None)


def commits(web, headers: dict) -> tuple[str, str | None]:
    """``(install.commit, install.loaded_commit)`` of a plugin whose health answers."""
    reply = web.get(f"{API}/health", headers=headers)
    assert reply.status_code == 200, reply.text
    info = reply.json()["install"]
    assert info["kind"] == "git install"
    return info["commit"], info["loaded_commit"]


def replace(web, headers: dict, repo: TwoCommits, ref: str) -> None:
    """Turn the plugin off, install ``ref`` over it with ``force``, and expect Hermes to turn it on again."""
    turn(web, headers, "disable")
    replaced = install(web, headers, repo, ref, force=True)
    assert (replaced.status_code, replaced.json()["ok"], replaced.json()["enabled"]) == (200, True, True)


@pytest.fixture
def served(web_without_plugin, token_headers, plugin_two_commits):
    """A server whose plugin was installed at the first commit and has answered once, which mounts its routes."""
    reply = install(web_without_plugin, token_headers, plugin_two_commits, plugin_two_commits.first, force=False)
    assert (reply.status_code, reply.json()["enabled"]) == (200, True)
    assert web_without_plugin.get(f"{API}/health", headers=token_headers).status_code == 200
    return web_without_plugin


def test_health_names_the_commit_the_plugin_was_installed_at_and_loaded_from(served, token_headers,
                                                                              plugin_two_commits):
    assert commits(served, token_headers) == (plugin_two_commits.first, plugin_two_commits.first)


def test_a_plugin_that_is_turned_on_cannot_be_replaced_over_rest(served, token_headers, plugin_two_commits):
    """Without a terminal Hermes takes the consent question for a refusal and publishes nothing, so the app
    must turn the plugin off before it installs the update."""
    refused = install(served, token_headers, plugin_two_commits, plugin_two_commits.second, force=True)

    assert refused.status_code == 400
    assert refused.json()["detail"].startswith("Plugin 'ergates' was not published: Reinstall declined"), refused.text
    assert runtime_status(served, token_headers) == "enabled"
    assert commits(served, token_headers) == (plugin_two_commits.first, plugin_two_commits.first)


def test_a_plugin_that_is_turned_off_is_replaced_and_the_server_keeps_running_the_old_code(
        served, token_headers, plugin_two_commits):
    """Hermes 0.21.6 mounts a plugin's routes once per process: after an update the record and the files name the
    new commit while the routes still run the code imported from the first one, until ``hermes serve`` restarts.

    If this assertion fails in the weekly run against the newest Hermes, Hermes now remounts plugin routes after
    an update. Nothing needs to change in the plugin or the app: the app sees that its update answered without a
    restart and then updates on that Hermes without asking (it learns this by itself).
    """
    turn(served, token_headers, "disable")
    replaced = install(served, token_headers, plugin_two_commits, plugin_two_commits.second, force=True)

    assert (replaced.status_code, replaced.json()["ok"], replaced.json()["enabled"]) == (200, True, True)
    assert runtime_status(served, token_headers) == "enabled"
    assert commits(served, token_headers) == (plugin_two_commits.second, plugin_two_commits.first)


def test_a_forced_install_that_fails_leaves_the_installed_tree_and_the_plugin_turned_off(
        served, token_headers, plugin_two_commits):
    """A commit that cannot be fetched fails before Hermes places anything, so the plugin stays turned off and the
    installed commit stays the one before, until the app turns the plugin on again."""
    replace(served, token_headers, plugin_two_commits, plugin_two_commits.second)
    turn(served, token_headers, "disable")

    failed = install(served, token_headers, plugin_two_commits, NOT_IN_THE_REPOSITORY, force=True)

    assert failed.status_code == 400
    prefixes = hermes_plugin_messages()["install"]["download_failed"]
    assert any(failed.json()["detail"].startswith(prefix) for prefix in prefixes), failed.text
    assert runtime_status(served, token_headers) != "enabled"
    turn(served, token_headers, "enable")
    assert commits(served, token_headers) == (plugin_two_commits.second, plugin_two_commits.first)


def test_routes_mounted_over_a_package_another_install_left_name_that_install_as_loaded(
        web_without_plugin, token_headers, plugin_broken_routes):
    """What going back after a broken update met on a real server. The new commit's ``dashboard/api.py``
    imported the ``ergates`` package and then failed, so Hermes mounted no routes but kept the package. The
    previous commit, installed over it, mounted its own ``api.py`` on the next request, and that file runs over
    the package of the broken commit. Health names the broken commit as loaded and the previous one as installed,
    so the app reads a restart to ask for instead of a plugin that is ready."""
    web = web_without_plugin
    broken = install(web, token_headers, plugin_broken_routes, plugin_broken_routes.second, force=False)
    assert (broken.status_code, broken.json()["enabled"]) == (200, True)
    assert web.get(f"{API}/health", headers=token_headers).status_code == 404

    replace(web, token_headers, plugin_broken_routes, plugin_broken_routes.first)

    assert commits(web, token_headers) == (plugin_broken_routes.first, plugin_broken_routes.second)
