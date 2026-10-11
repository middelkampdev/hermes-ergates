"""The profile names Hermes refuses to create.

`ergates/proposals.py` refuses a proposal for one of these names
(`HERMES_RESERVED_PROFILE_NAMES`): `profiles.create` would answer 4062, while
the accept already reserved the name and nothing releases it. Hermes keeps the
set in a private constant, so Ergates holds a copy and this test keeps the
copy equal to the pin.
"""

from __future__ import annotations

from ergates.proposals import HERMES_RESERVED_PROFILE_NAMES
from pinned import PinnedSource

PROFILES = "hermes_cli/profiles.py"
RPC = "tui_gateway/methods_profiles.py"


def test_the_copy_equals_the_reserved_names_of_the_pin(hermes: PinnedSource) -> None:
    # hermes_cli/profiles.py:271
    assert hermes.assigned(PROFILES, "_RESERVED_NAMES") == HERMES_RESERVED_PROFILE_NAMES


def test_validate_profile_name_refuses_every_reserved_name(hermes: PinnedSource) -> None:
    # hermes_cli/profiles.py:395-400
    assert hermes.lines(PROFILES, 395, 400) == (
        "    if name in _RESERVED_NAMES:\n"
        "        raise ValueError(\n"
        "            f\"Profile name {name!r} is reserved — it collides with either \"\n"
        "            f\"the Hermes installation itself or a common system binary.  \"\n"
        "            f\"Pick a different name.\"\n"
        "        )"
    )


def test_create_profile_refuses_default_on_its_own(hermes: PinnedSource) -> None:
    # `validate_profile_name` lets "default" through (it is the built-in
    # profile); `create_profile` refuses it right after. hermes_cli/profiles.py:1405-1407
    assert hermes.lines(PROFILES, 1405, 1407) == (
        "    canon = _canon_valid(name)\n"
        "    if canon == \"default\":\n"
        "        raise ValueError(\"Cannot create a profile named 'default' — it is the built-in profile (~/.hermes).\")"
    )


def test_the_create_rpc_answers_a_refused_name_with_4062(hermes: PinnedSource) -> None:
    # tui_gateway/methods_profiles.py:319-326
    assert hermes.lines(RPC, 319, 326) == (
        "        path = profiles_mod.create_profile(\n"
        "            name=name, clone_from=clone_from, clone_all=clone_all,\n"
        "            clone_config=bool(clone_from) and not clone_all,\n"
        "            no_skills=is_truthy_value(params.get(\"no_skills\", False)),\n"
        "            description=str(params.get(\"description\") or \"\").strip() or None,\n"
        "            clone_channels=is_truthy_value(params.get(\"clone_channels\", False)))\n"
        "    except (ValueError, FileExistsError, FileNotFoundError) as e:\n"
        "        return _err(rid, 4062, str(e))"
    )
