"""Tests for ergates.templates: the proposal templates the accept route answers with."""

import json

import pytest

from ergates.paths import templates_dir
from ergates.proposals import ProposalError
from ergates.templates import load_template

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
