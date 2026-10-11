"""Tests for ergates.settings: the install-wide push settings in the Hermes root's config.yaml."""

import logging

from ergates.delivery import NtfySettings
from ergates.settings import load_settings, push_settings, settings_from_config

SETTINGS = {"server": "https://ntfy.example.internal", "topic": "ergates-alerts", "token": "tok",
            "connection_id": "conn-1"}


def _config(**ntfy):
    return {"plugins": {"entries": {"ergates": {"settings": {"ntfy": ntfy}}}}}


def _write_config(home, **ntfy):
    """A config.yaml shaped exactly like the one the runbook edits."""
    settings = ntfy or SETTINGS
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        "plugins:\n"
        "  entries:\n"
        "    ergates:\n"
        "      settings:\n"
        "        ntfy:\n"
        + "".join(f"          {key}: {value}\n" for key, value in settings.items()),
        encoding="utf-8",
    )


def test_settings_come_from_the_plugin_entry_in_the_config():
    settings = settings_from_config(_config(server="https://x", topic="t", token="tok", connection_id="c"))

    assert settings == {"server": "https://x", "topic": "t", "token": "tok", "connection_id": "c"}


def test_settings_are_empty_when_the_plugin_is_not_configured():
    assert settings_from_config({}) == {}
    assert settings_from_config({"plugins": {}}) == {}
    assert settings_from_config(_config()) == {}


def test_settings_tolerate_a_config_of_the_wrong_shape():
    """A hook or a maintenance sweep must not die on a config typo."""
    assert settings_from_config({"plugins": {"entries": {"ergates": "oops"}}}) == {}
    assert settings_from_config({"plugins": "oops"}) == {}
    assert settings_from_config(_config(server="", topic=None, token=7)) == {}
    assert settings_from_config({"plugins": {"entries": {"ergates": {"settings": {"ntfy": "oops"}}}}}) == {}


def test_load_settings_returns_empty_when_there_is_no_config_file(tmp_path):
    assert load_settings(tmp_path) == {}


def test_load_settings_reads_the_root_config(tmp_path):
    _write_config(tmp_path)

    assert load_settings(tmp_path) == SETTINGS


def test_push_settings_are_on_only_with_a_server_and_a_topic(tmp_path):
    assert push_settings(tmp_path) is None
    _write_config(tmp_path, server="https://ntfy.example.internal")
    assert push_settings(tmp_path) is None

    _write_config(tmp_path)
    assert push_settings(tmp_path) == NtfySettings(**SETTINGS)


# --- a "${VAR}" left unexpanded is refused loudly, never sent ----------------------------


def test_a_setting_that_still_has_unexpanded_dollar_braces_is_dropped_and_logged(tmp_path, caplog):
    """Values are read as written (PyYAML does not expand ${VAR}); an owner who
    typed a template reference by mistake must not have it sent to ntfy as a
    literal string, and the setting key (never the value) is logged."""
    _write_config(tmp_path, server="${NTFY_SERVER}", topic="ergates-alerts", token="tok", connection_id="conn-1")

    with caplog.at_level(logging.WARNING, logger="ergates.settings"):
        settings = load_settings(tmp_path)

    assert "server" not in settings
    assert settings == {"topic": "ergates-alerts", "token": "tok", "connection_id": "conn-1"}
    assert "server" in caplog.text
    # The key is named; the value ("${NTFY_SERVER}") never is.
    assert "NTFY_SERVER" not in caplog.text


def test_a_dollar_braces_value_turns_push_off_when_it_is_server_or_topic(tmp_path):
    _write_config(tmp_path, server="${NTFY_SERVER}", topic="ergates-alerts")
    assert push_settings(tmp_path) is None

    _write_config(tmp_path, server="https://ntfy.example.internal", topic="${NTFY_TOPIC}")
    assert push_settings(tmp_path) is None


def test_a_dollar_braces_token_does_not_block_the_other_settings(tmp_path):
    """token and connection_id are not required for push to be on; a bad token
    just means no Authorization header, same as an unset one."""
    settings = _config(server="https://ntfy.example.internal", topic="ergates-alerts",
                        token="${NTFY_TOKEN}", connection_id="conn-1")
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "config.yaml").write_text(
        "plugins:\n  entries:\n    ergates:\n      settings:\n        ntfy:\n"
        "          server: https://ntfy.example.internal\n"
        "          topic: ergates-alerts\n"
        "          token: ${NTFY_TOKEN}\n"
        "          connection_id: conn-1\n",
        encoding="utf-8",
    )

    settings = push_settings(tmp_path)

    assert settings == NtfySettings(server="https://ntfy.example.internal", topic="ergates-alerts",
                                    token="", connection_id="conn-1")
