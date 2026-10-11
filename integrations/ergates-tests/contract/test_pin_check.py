"""The pin check refuses a dirty checkout.

Like `check_pin()` in `scripts/ci-local.sh`, `pinned.check_pin` fails a Hermes
checkout that is at the pin but has uncommitted edits or untracked files, not
just one at the wrong commit, so the `hermes` fixture refuses the same way for
every invocation path, not only the ones that go through
`prepare_hermes_source`. These tests run it against a throwaway git repo built
in `tmp_path`; they never touch the real Hermes checkout or `.cache/hermes-pin`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from pinned import HERMES_PIN, check_pin, expected_ref


def _git(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)


def _init_repo(root: Path) -> str:
    """A one-commit git repo under `root`; returns its HEAD hash."""
    _git("init", "-q", cwd=root)
    (root / "tracked.txt").write_text("original\n", encoding="utf-8")
    _git("add", "tracked.txt", cwd=root)
    _git(
        "-c", "user.email=contract-test@example.com", "-c", "user.name=Contract Test",
        "commit", "-q", "-m", "initial", cwd=root,
    )
    return _git("rev-parse", "HEAD", cwd=root).stdout.strip()


def test_a_checkout_at_the_pin_with_local_edits_fails_naming_the_checkout(tmp_path: Path) -> None:
    pin = _init_repo(tmp_path)
    (tmp_path / "tracked.txt").write_text("edited\n", encoding="utf-8")

    failure = check_pin(tmp_path, pin)

    assert failure is not None
    assert str(tmp_path) in failure
    assert "local edits" in failure


def test_a_checkout_at_the_pin_with_an_untracked_file_fails_naming_the_checkout(tmp_path: Path) -> None:
    pin = _init_repo(tmp_path)
    (tmp_path / "stray.py").write_text("print('not part of the pin')\n", encoding="utf-8")

    failure = check_pin(tmp_path, pin)

    assert failure is not None
    assert str(tmp_path) in failure
    assert "local edits" in failure


def test_a_clean_checkout_at_the_pin_passes(tmp_path: Path) -> None:
    pin = _init_repo(tmp_path)

    assert check_pin(tmp_path, pin) is None


def test_a_checkout_at_the_wrong_commit_fails_naming_the_checkout(tmp_path: Path) -> None:
    _init_repo(tmp_path)

    failure = check_pin(tmp_path, "0" * 40)

    assert failure is not None
    assert str(tmp_path) in failure


def test_expected_ref_overrides_the_pin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    head = _init_repo(tmp_path)
    monkeypatch.setenv("HERMES_EXPECTED_REF", head)

    assert expected_ref() == head
    assert check_pin(tmp_path, expected_ref()) is None


def test_without_the_override_the_pin_is_expected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HERMES_EXPECTED_REF", raising=False)

    assert expected_ref() == HERMES_PIN


def test_an_empty_override_means_the_pin(monkeypatch: pytest.MonkeyPatch) -> None:
    # A workflow expression that resolves to nothing leaves the variable set but empty.
    monkeypatch.setenv("HERMES_EXPECTED_REF", "")

    assert expected_ref() == HERMES_PIN
