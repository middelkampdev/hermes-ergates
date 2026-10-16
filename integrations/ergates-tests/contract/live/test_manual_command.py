"""The commands the app's Finish screen shows, run the way a user runs them on a server.

The Finish screen fills in the templates of
``apps/mobile/src/features/server/manual-commands.json``. These tests read the
same file, fill it in for ``plugin_monorepo`` (the plugin in
``integrations/ergates`` of a repository, at its commit, the layout of its own
repository) and run each command with ``run_hermes``: without a terminal, on the
root of a running server.

Hermes 0.21.6 asks for consent to the Python dependencies of any plugin with a
``pyproject.toml``, even one that lists none, and without a terminal it takes
that as a no: the plugin is installed but stays turned off
(``hermes_cli/plugins_cmd_install.py`` ``_consent_python_deps``).
``--yes-deps`` gives the answer up front. The running server loads a plugin
enabled behind its back on the first request to its routes, so health answers
without a restart.
"""

from __future__ import annotations

import shlex

from app_messages import hermes_plugin_messages, manual_commands

API = "/api/plugins/ergates"
HUB = "/api/dashboard/plugins/hub"


def command(template: str, **values: str) -> list[str]:
    """The arguments of ``template`` after ``hermes``, split as a shell splits them, with every ``{name}``
    in ``values`` filled in."""
    words = shlex.split(template)
    assert words[0] == "hermes", template
    filled = []
    for word in words[1:]:
        for name, value in values.items():
            word = word.replace(f"{{{name}}}", value)
        filled.append(word)
    assert not any("{" in word for word in filled), filled
    return filled


def runtime_status(web, headers: dict) -> str | None:
    """The plugin's ``runtime_status`` in the plugin list the app reads, or None when the list has no row."""
    reply = web.get(HUB, headers=headers)
    assert reply.status_code == 200, reply.text
    return next((row["runtime_status"] for row in reply.json()["plugins"] if row["name"] == "ergates"), None)


def test_the_install_and_update_commands_leave_the_plugin_enabled_and_served_without_a_terminal_or_a_restart(
        web_without_plugin, root_without_plugin, token_headers, run_hermes, plugin_monorepo):
    web = web_without_plugin
    templates = manual_commands()
    pin = {"identifier": plugin_monorepo.identifier, "commit": plugin_monorepo.sha}
    assert web.get(f"{API}/health", headers=token_headers).status_code == 404

    installed = run_hermes(root_without_plugin, command(templates["install"], **pin))

    assert installed.returncode == 0
    assert runtime_status(web, token_headers) == "enabled"
    health = web.get(f"{API}/health", headers=token_headers)
    assert health.status_code == 200, health.text
    assert health.json()["install"] == {"kind": "git install", "commit": plugin_monorepo.sha, "catalog_name": None,
                                        "loaded_commit": plugin_monorepo.sha}

    updated = run_hermes(root_without_plugin, command(templates["update"], **pin))

    assert updated.returncode == 0
    assert runtime_status(web, token_headers) == "enabled"
    assert web.get(f"{API}/health", headers=token_headers).status_code == 200


def test_without_yes_deps_the_install_leaves_the_plugin_off_and_the_enable_command_turns_it_on(
        web_without_plugin, root_without_plugin, token_headers, run_hermes, plugin_monorepo):
    """Why the install commands carry ``--yes-deps``, and the way back the Finish screen offers for a plugin
    that was installed without it."""
    web = web_without_plugin
    templates = manual_commands()
    without_consent = templates["install"].replace(" --yes-deps", "")
    assert without_consent != templates["install"]
    not_served = {"detail": hermes_plugin_messages()["pluginNotFound"]}

    installed = run_hermes(root_without_plugin, command(without_consent, identifier=plugin_monorepo.identifier,
                                                        commit=plugin_monorepo.sha))

    assert installed.returncode == 0
    # Hermes lists a plugin it never turned on as `inactive`; the app reads every status but `enabled` as off.
    assert runtime_status(web, token_headers) in {"disabled", "inactive"}
    off = web.get(f"{API}/health", headers=token_headers)
    assert (off.status_code, off.json()) == (404, not_served)

    enabled = run_hermes(root_without_plugin, command(templates["enable"], name="ergates"))

    assert enabled.returncode == 0
    assert runtime_status(web, token_headers) == "enabled"
    assert web.get(f"{API}/health", headers=token_headers).status_code == 200
