"""Tests for ergates.settings: the install-wide push settings in the Hermes root's config.yaml,
and the ntfy token, a Hermes plugin secret in the root's .env."""

import logging

import yaml

from ergates import hermes_adapter
from ergates.delivery import NtfySettings
from ergates.settings import (
    SETTING_KEYS,
    TOKEN_ENV,
    load_settings,
    push_settings,
    settings_from_config,
    sweep_interval,
)
from ergates.sweep import SWEEP_INTERVAL_SECONDS
from ergates.tool import DEFAULT_COMPLETED_PLATFORMS
from plugin_tree import PLUGIN_DIR

SETTINGS = {"server": "https://ntfy.example.internal", "topic": "ergates-alerts", "connection_id": "conn-1"}


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
    settings = settings_from_config(_config(server="https://x", topic="t", connection_id="c"))

    assert settings == {"server": "https://x", "topic": "t", "connection_id": "c"}


def test_settings_are_empty_when_the_plugin_is_not_configured():
    assert settings_from_config({}) == {}
    assert settings_from_config({"plugins": {}}) == {}
    assert settings_from_config(_config()) == {}


def test_settings_tolerate_a_config_of_the_wrong_shape():
    """A hook or a maintenance sweep must not die on a config typo."""
    assert settings_from_config({"plugins": {"entries": {"ergates": "oops"}}}) == {}
    assert settings_from_config({"plugins": "oops"}) == {}
    assert settings_from_config(_config(server="", topic=None, connection_id=7)) == {}
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
    _write_config(tmp_path, server="${NTFY_SERVER}", topic="ergates-alerts", connection_id="conn-1")

    with caplog.at_level(logging.WARNING, logger="ergates.settings"):
        settings = load_settings(tmp_path)

    assert "server" not in settings
    assert settings == {"topic": "ergates-alerts", "connection_id": "conn-1"}
    assert "server" in caplog.text
    # The key is named; the value ("${NTFY_SERVER}") never is.
    assert "NTFY_SERVER" not in caplog.text


def test_a_dollar_braces_value_turns_push_off_when_it_is_server_or_topic(tmp_path):
    _write_config(tmp_path, server="${NTFY_SERVER}", topic="ergates-alerts")
    assert push_settings(tmp_path) is None

    _write_config(tmp_path, server="https://ntfy.example.internal", topic="${NTFY_TOPIC}")
    assert push_settings(tmp_path) is None


def test_a_dollar_braces_connection_id_does_not_block_the_other_settings(tmp_path):
    """connection_id is not required for push to be on; a bad one just means a
    deep link without a connection, same as an unset one."""
    _write_config(tmp_path, server="https://ntfy.example.internal", topic="ergates-alerts",
                  connection_id="${CONNECTION_ID}")

    settings = push_settings(tmp_path)

    assert settings == NtfySettings(server="https://ntfy.example.internal", topic="ergates-alerts")


# --- the ntfy token: a Hermes plugin secret, never a config.yaml value ------------


def test_the_token_comes_from_the_install_secret_not_config_yaml(tmp_path, monkeypatch):
    _write_config(tmp_path, server="https://ntfy.example.internal", topic="ergates-alerts", token="old")
    asked = []
    monkeypatch.setattr(hermes_adapter, "install_secret", lambda name: asked.append(name) or "new")

    settings = load_settings(tmp_path)

    assert TOKEN_ENV == "ERGATES_NTFY_TOKEN"
    assert SETTING_KEYS == ("server", "topic", "connection_id")
    assert settings == {"server": "https://ntfy.example.internal", "topic": "ergates-alerts", "token": "new"}
    assert asked == ["ERGATES_NTFY_TOKEN"]
    assert push_settings(tmp_path).token == "new"


def test_a_token_left_in_config_yaml_is_ignored_and_logged_without_its_value(tmp_path, monkeypatch, caplog):
    """A 0.2 install kept the token in config.yaml. It is not sent any more, and the
    log says where it goes now, without the value."""
    _write_config(tmp_path, server="https://ntfy.example.internal", topic="ergates-alerts",
                  token="tk_left_in_config")
    monkeypatch.setattr(hermes_adapter, "install_secret", lambda name: None)

    with caplog.at_level(logging.WARNING, logger="ergates.settings"):
        settings = load_settings(tmp_path)

    assert settings == {"server": "https://ntfy.example.internal", "topic": "ergates-alerts"}
    assert len(caplog.records) == 1
    assert "ntfy.token" in caplog.text
    assert "ERGATES_NTFY_TOKEN" in caplog.text
    assert "tk_left_in_config" not in caplog.text
    assert push_settings(tmp_path).token == ""


def test_the_settings_form_declares_every_setting_with_the_defaults_the_code_uses():
    """Hermes builds the plugin's settings form from plugin.yaml's config_schema and shows its defaults."""
    schema = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))["config_schema"]

    assert sorted(schema) == sorted([*(f"ntfy.{key}" for key in (*SETTING_KEYS, "token")),
                                     "sweep.interval_seconds", "attention.completed_platforms"])
    assert all(spec["description"].strip() for spec in schema.values())
    assert schema["ntfy.token"] == {"type": "secret", "env": TOKEN_ENV,
                                    "description": schema["ntfy.token"]["description"]}
    assert schema["sweep.interval_seconds"]["default"] == SWEEP_INTERVAL_SECONDS
    assert set(schema["attention.completed_platforms"]["default"]) == DEFAULT_COMPLETED_PLATFORMS


# --- the periodic sweep's interval ----------------------------------------------

SWEEP_KEY = "plugins.entries.ergates.settings.sweep.interval_seconds"


def _write_sweep_interval(home, value):
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        f"plugins:\n  entries:\n    ergates:\n      settings:\n        sweep:\n          interval_seconds: {value}\n",
        encoding="utf-8",
    )


def test_sweep_interval_reads_the_root_setting_and_falls_back_on_nonsense(tmp_path, caplog):
    assert sweep_interval(tmp_path) == SWEEP_INTERVAL_SECONDS  # no config.yaml
    _write_config(tmp_path)
    assert sweep_interval(tmp_path) == SWEEP_INTERVAL_SECONDS  # a config without the setting
    for value, expected in (("60", 60), ("0", 0), ("3600", 3600)):
        _write_sweep_interval(tmp_path, value)
        assert sweep_interval(tmp_path) == expected, value
    assert caplog.records == []

    for nonsense in ("-5", "fast", "1.5", "true", "null", "[60]"):
        caplog.clear()
        _write_sweep_interval(tmp_path, nonsense)
        with caplog.at_level(logging.WARNING, logger="ergates.settings"):
            assert sweep_interval(tmp_path) == SWEEP_INTERVAL_SECONDS, nonsense
        assert SWEEP_KEY in caplog.text, nonsense
        assert nonsense not in caplog.text.replace(SWEEP_KEY, ""), nonsense


def test_sweep_interval_is_read_from_the_root_only(tmp_path):
    _write_sweep_interval(tmp_path / "profiles" / "thijs", "0")

    assert sweep_interval(tmp_path) == SWEEP_INTERVAL_SECONDS


def test_sweep_interval_is_the_default_when_config_yaml_is_unreadable(tmp_path, caplog):
    """The sweep must not stop over a config typo; the log names the error class, never the file's text."""
    (tmp_path / "config.yaml").write_text("plugins: [unclosed\n", encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="ergates.settings"):
        assert sweep_interval(tmp_path) == SWEEP_INTERVAL_SECONDS

    assert "ParserError" in caplog.text
    assert "unclosed" not in caplog.text
