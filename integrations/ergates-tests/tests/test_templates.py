"""Tests for ergates.templates: the proposal templates the accept route answers with."""

import json
import os

import pytest

from conftest import returns_within
from ergates.paths import templates_dir
from ergates.proposals import ProposalError
from ergates.templates import MAX_TEMPLATE_BYTES, load_template

TEMPLATE = {
    "template_id": "bookkeeper",
    "soul": "You are a careful bookkeeper.",
    "enabled_toolsets": ["file", "web"],
    "enabled_mcp_servers": [],
}


def _write(directory, name, content):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(content if isinstance(content, str) else json.dumps(content),
                                            encoding="utf-8")


def _unknown(directory, template_id):
    with pytest.raises(ProposalError) as caught:
        load_template(directory, template_id)
    assert (caught.value.code, caught.value.http_status) == ("unknown_template", 422)


def test_templates_live_under_the_hermes_root(tmp_path):
    assert templates_dir(tmp_path) == tmp_path / "ergates" / "templates"


def test_a_template_file_is_read_with_exactly_the_documented_fields(tmp_path):
    directory = templates_dir(tmp_path)
    _write(directory, "bookkeeper", {**TEMPLATE, "notes": "not part of the contract"})

    assert load_template(directory, "bookkeeper") == TEMPLATE


def test_a_missing_template_is_unknown(tmp_path):
    _unknown(templates_dir(tmp_path), "bookkeeper")


@pytest.mark.parametrize("template_id", [
    "../secrets", "a/b", ".hidden", "Bookkeeper", "", None, 7, "x" * 65, "bookkeeper\n",
])
def test_an_id_that_is_not_a_safe_file_name_is_unknown(tmp_path, template_id):
    _unknown(templates_dir(tmp_path), template_id)


@pytest.mark.parametrize("content", [
    "{not json",
    json.dumps(["a list"]),
    json.dumps({**TEMPLATE, "template_id": "another-template"}),
    json.dumps({**TEMPLATE, "soul": None}),
    json.dumps({**TEMPLATE, "enabled_toolsets": "file"}),
    json.dumps({**TEMPLATE, "enabled_mcp_servers": [""]}),
    # profiles.configure reads [] as "no toolset pin": the agent would get Hermes's defaults.
    json.dumps({**TEMPLATE, "enabled_toolsets": []}),
])
def test_a_broken_template_file_is_unknown_and_logged_without_its_content(tmp_path, caplog, content):
    directory = templates_dir(tmp_path)
    _write(directory, "bookkeeper", content)

    _unknown(directory, "bookkeeper")

    assert "bookkeeper.json" in caplog.text
    assert "careful bookkeeper" not in caplog.text


# --- a template name that is not a regular file -------------------------------


def _unknown_within(seconds, directory, template_id):
    """``_unknown``, failing the test when the read blocks instead of answering."""
    def call():
        with pytest.raises(ProposalError) as caught:
            load_template(directory, template_id)
        return caught.value

    error = returns_within(seconds, call)
    assert (error.code, error.http_status) == ("unknown_template", 422)


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs on this platform")
def test_a_fifo_at_a_template_name_is_unknown_without_blocking(tmp_path):
    """An open for reading waits for a writer on a FIFO nobody writes to, so a plain read stalls the request."""
    directory = templates_dir(tmp_path)
    directory.mkdir(parents=True)
    os.mkfifo(directory / "bookkeeper.json")

    _unknown_within(5, directory, "bookkeeper")


def test_a_symlink_at_a_template_name_is_unknown_and_never_followed(tmp_path, caplog):
    elsewhere = tmp_path / "elsewhere"
    _write(elsewhere, "bookkeeper", TEMPLATE)
    directory = templates_dir(tmp_path)
    directory.mkdir(parents=True)
    (directory / "bookkeeper.json").symlink_to(elsewhere / "bookkeeper.json")

    _unknown_within(5, directory, "bookkeeper")
    assert "careful bookkeeper" not in caplog.text


def test_a_templates_folder_that_is_a_symlink_is_never_followed(tmp_path):
    elsewhere = tmp_path / "elsewhere"
    _write(elsewhere, "bookkeeper", TEMPLATE)
    directory = templates_dir(tmp_path)
    directory.parent.mkdir(parents=True)
    directory.symlink_to(elsewhere, target_is_directory=True)

    _unknown_within(5, directory, "bookkeeper")


def test_a_template_file_past_the_size_limit_is_unknown(tmp_path):
    """Valid JSON padded past the limit: the file is refused by its size, before it is read."""
    directory = templates_dir(tmp_path)
    text = json.dumps(TEMPLATE)
    _write(directory, "bookkeeper", text + " " * (MAX_TEMPLATE_BYTES + 1 - len(text)))

    _unknown_within(5, directory, "bookkeeper")


def test_a_folder_at_a_template_name_is_unknown(tmp_path):
    (templates_dir(tmp_path) / "bookkeeper.json").mkdir(parents=True)

    _unknown_within(5, templates_dir(tmp_path), "bookkeeper")


def test_a_template_file_at_the_size_limit_is_read(tmp_path):
    directory = templates_dir(tmp_path)
    text = json.dumps(TEMPLATE)
    _write(directory, "bookkeeper", text + " " * (MAX_TEMPLATE_BYTES - len(text)))

    assert load_template(directory, "bookkeeper") == TEMPLATE
