"""The dashboard/ folder: what `hermes serve` reads to mount the Ergates router (ADR-031).

``contract/live/test_dashboard_api.py`` proves the mount inside Hermes's own
server; this test keeps the files consistent without Hermes.
"""

import ast
import json
import string
from pathlib import Path

import ergates

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "ergates"
DASHBOARD = PLUGIN_DIR / "dashboard"


def test_the_manifest_names_the_router_and_a_hidden_tab():
    manifest = json.loads((DASHBOARD / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["name"] == "ergates"
    assert manifest["api"] == "api.py" and (DASHBOARD / "api.py").is_file()
    assert manifest["entry"] == "index.js" and (DASHBOARD / "index.js").is_file()
    assert manifest["tab"]["hidden"] is True
    assert manifest["version"] == ergates.__version__


def _route_paths():
    """Every path in a ``@router.<method>("<path>")`` decorator of api.py."""
    tree = ast.parse((DASHBOARD / "api.py").read_text(encoding="utf-8"))
    return [
        decorator.args[0].value
        for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef)
        for decorator in node.decorator_list
        if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
        and isinstance(decorator.func.value, ast.Name) and decorator.func.value.id == "router"
    ]


def test_no_route_names_a_path_parameter_profile():
    """Hermes scopes each plugin request to the profile a parameter named
    ``profile`` names, and refuses an unknown one with its own 404 before the
    route runs (contract/test_dashboard_api_mount.py). A route path parameter
    of that name would hand Hermes the answer the app reads as
    ``unknown_profile``."""
    paths = _route_paths()
    fields = {field for path in paths for _, field, _, _ in string.Formatter().parse(path) if field}

    assert "/profiles/{name}/plugin" in paths
    assert "profile" not in fields


def _parents(tree):
    return {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}


def _reads_the_profile_query(node):
    """``request.query_params.get("profile")`` / ``.getlist("profile")`` / ``["profile"]``."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {"get", "getlist"}:
        target, key = node.func.value, node.args[0] if node.args else None
    elif isinstance(node, ast.Subscript):
        target, key = node.value, node.slice
    else:
        return False
    return (isinstance(target, ast.Attribute) and target.attr == "query_params"
            and isinstance(key, ast.Constant) and key.value == "profile")


def test_a_profile_parameter_carries_nothing_but_a_profile_name():
    """Hermes takes a ``profile`` path or query parameter as the profile the request runs
    in and refuses anything that is no live profile name (contract/test_dashboard_api_mount.py),
    so a route must not read another value, such as ``*``, from it. A ``?profile=`` read
    may only feed ``named_profile=``, which takes a profile name and nothing else
    (tests/test_operations.py); no route handler takes a parameter named ``profile``."""
    tree = ast.parse((DASHBOARD / "api.py").read_text(encoding="utf-8"))
    parents = _parents(tree)
    reads = [node for node in ast.walk(tree) if _reads_the_profile_query(node)]
    handlers = [node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef) and node.decorator_list]

    assert reads, "GET /attention/prefs still accepts ?profile=<name>"
    for node in reads:
        keyword = parents[node]
        assert isinstance(keyword, ast.keyword) and keyword.arg == "named_profile", ast.unparse(parents[node])
    for handler in handlers:
        assert "profile" not in {arg.arg for arg in handler.args.args + handler.args.kwonlyargs}, handler.name
