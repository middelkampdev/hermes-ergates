"""Install the plugin into a Hermes install: ``python -m ergates.install``.

Two things a new deployment and every update need, both safe to repeat:

1. **The proposal templates.** The plugin ships them in its own folder
   (``templates/``, :func:`~ergates.paths.bundled_templates_dir`). Every
   ``<template_id>.json`` there must be a template the accept route would
   serve (:func:`ergates.templates.load_template`). Then each is written
   into ``<hermes root>/ergates/templates/``, and a template the plugin no
   longer ships is removed there, so the server holds exactly the reviewed
   set (:func:`ergates.setup.ensure_templates`). When any template is
   invalid, nothing is written. ``hermes serve`` does the same on its first
   request; this command does it without a request.
2. **The plugin in every profile.** Hermes loads a user plugin only from the
   active home's ``plugins/`` folder, and only when that home's
   ``config.yaml`` enables it, so :func:`~ergates.hermes_adapter.enable_plugin`
   runs for the default profile and every named one
   (:func:`ergates.setup.enable_everywhere`, the code behind ``POST /setup``).
   The app's provisioning does the same for a profile it creates.

``--check`` changes no template or plugin setting and reports the same facts. The exit code is 0
when every profile would load the plugin and the installed templates equal
the shipped ones, 1 when not, and 2 when the command cannot run: no Hermes
runtime, no template folder, or root on a Hermes root that another user owns
(:func:`~ergates.store.root_run_would_break`).
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional

from . import hermes_adapter
from .paths import bundled_templates_dir, hermes_root, templates_dir
from .setup import (
    INSTALLED,
    TemplateSourceError,
    enable_everywhere,
    ensure_templates,
    source_templates,
    templates_state,
)
from .store import root_run_would_break


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ergates.install",
        description="Install the proposal templates and enable the ergates plugin in every Hermes profile.",
    )
    parser.add_argument("--check", action="store_true", help="change nothing; report and set the exit code")
    args = parser.parse_args(argv)

    root = hermes_root()
    if not root.exists():
        print(f"ergates.install: no Hermes home at {root}", file=sys.stderr)
        return 2
    if root_run_would_break(root):
        print(f"ergates.install: refusing to run as root; {root} belongs to another user. "
              "Run it as that user (sudo -u <user> ..., or docker exec -u <user> ... in a container).",
              file=sys.stderr)
        return 2
    source = bundled_templates_dir()
    if not source.is_dir():
        print(f"ergates.install: no template folder at {source}", file=sys.stderr)
        return 2
    try:
        templates = source_templates(source)
    except TemplateSourceError as exc:
        print(f"ergates.install: {exc}; nothing was installed", file=sys.stderr)
        return 1
    if not templates and not args.check:
        print(f"ergates.install: no templates found at {source}; nothing was installed", file=sys.stderr)
        return 2
    try:
        profiles = hermes_adapter.profile_names()
    except ImportError:
        print("ergates.install: needs the Hermes runtime (run it inside the Hermes container)", file=sys.stderr)
        return 2

    target = templates_dir(root)
    state = templates_state(source, target) if args.check else ensure_templates(source, target)
    ok = state == INSTALLED
    print(f"ergates.install: templates={state} ({', '.join(sorted(templates)) or 'none'})")
    # --check only asks: enabling is a no-op there, so the same loop reports both.
    enable = (lambda profile: None) if args.check else hermes_adapter.enable_plugin
    for item in enable_everywhere(profiles, enable, hermes_adapter.plugin_enabled):
        if "error" in item:
            plugin = f"failed ({item['error']})"
        else:
            plugin = "enabled" if item["enabled"] else "not enabled"
        ok = ok and item["enabled"]
        print(f"ergates.install: profile={item['name']} plugin={plugin}")
    return 0 if ok else 1


if __name__ == "__main__":  # pragma: no cover - exercised through main() in tests
    raise SystemExit(main())
