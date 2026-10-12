"""Static checks of deploy/: the wiring contract of docs/03 section 9, without Docker.

`scripts/ci-local.sh deploy` also runs `docker compose config`, which checks
Compose syntax and interpolation. These tests check what Compose accepts but
the design forbids: a port on 0.0.0.0, a missing plugin mount, a socket in the
wrong container, a profile without the approval settings, a route out that
skips the egress proxy, an image that is not pinned by digest.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parents[1]
# The accept route's own template check; the ergates package needs no dependency.
sys.path.insert(0, str(DEPLOY.parent / "integrations" / "ergates"))
from ergates.templates import load_template  # noqa: E402

# The proposal templates ship inside the plugin folder the controllers mount.
TEMPLATES_DIR = DEPLOY.parent / "integrations" / "ergates" / "templates"
TEMPLATES = sorted(path.stem for path in TEMPLATES_DIR.glob("*.json"))
COMPOSE_TEXT = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
COMPOSE = yaml.safe_load(COMPOSE_TEXT)
SERVICES = COMPOSE["services"]
CONTROLLERS = ("hermes-serve", "hermes-gateway")
BEHIND_THE_PROXY = ("hermes-serve", "hermes-gateway", "ntfy")
PROXY_URL = "http://egress-proxy:3128"
# repository:tag@sha256:<64 hex>, the tag kept for people and the digest for Docker.
PINNED_IMAGE = re.compile(r"^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$")
HOSTNAME = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
PLUGIN_MOUNT = "../integrations/ergates:/opt/data/plugins/ergates:ro"
DOCKER_SOCKET = "/var/run/docker.sock:/var/run/docker.sock"
PROFILES = sorted(path.parent.name for path in DEPLOY.glob("profiles/*/config.yaml"))


def env_example() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (DEPLOY / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def profile(name: str) -> dict:
    return yaml.safe_load((DEPLOY / "profiles" / name / "config.yaml").read_text(encoding="utf-8"))


def config_lines(relative: str) -> list[str]:
    """The settings of the proxy or ingress config: stripped lines, without blanks and comments."""
    lines = (DEPLOY / relative).read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]


def test_the_stack_is_serve_gateway_ntfy_the_egress_proxy_and_the_ingress() -> None:
    assert set(SERVICES) == {"hermes-serve", "hermes-gateway", "ntfy", "egress-proxy", "ingress"}


def test_every_required_variable_has_an_example_value() -> None:
    required = set(re.findall(r"\$\{([A-Z0-9_]+):\?", COMPOSE_TEXT))
    assert required == {
        "TAILSCALE_IP",
        "HERMES_DASHBOARD_BASIC_AUTH_USERNAME",
        "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH",
        "HERMES_DASHBOARD_BASIC_AUTH_SECRET",
        "DOCKER_SOCK_GID",
    }
    examples = env_example()
    assert sorted(name for name in required if not examples.get(name)) == []


def test_ports_are_published_only_by_the_ingress_and_only_on_the_tailscale_ip() -> None:
    assert sorted(name for name, service in SERVICES.items() if service.get("ports")) == ["ingress"]
    published = SERVICES["ingress"]["ports"]
    assert [port.partition("}:")[2] for port in published] == [
        "9119:9119", "${NTFY_PORT:-8080}:8080"]
    assert all(port.startswith("${TAILSCALE_IP:?") for port in published)


def test_no_service_uses_the_host_network() -> None:
    """network_mode: host would skip both the published-port rule and the internal network."""
    assert [name for name, service in SERVICES.items() if "network_mode" in service] == []


def test_only_the_egress_proxy_and_the_ingress_have_a_route_out() -> None:
    networks = COMPOSE["networks"]
    assert networks["internal"]["internal"] is True
    assert networks["edge"].get("internal", False) is False
    assert set(networks) == {"internal", "edge"}
    for name in BEHIND_THE_PROXY:
        assert SERVICES[name]["networks"] == ["internal"], name
    for name in ("egress-proxy", "ingress"):
        assert sorted(SERVICES[name]["networks"]) == ["edge", "internal"], name


def test_both_networks_are_created_by_this_file() -> None:
    """An `external` network is made elsewhere, with settings these checks cannot see."""
    assert [name for name, network in COMPOSE["networks"].items() if "external" in network] == []


def test_the_internal_network_has_no_gateway_on_the_host() -> None:
    """An internal bridge still gets an address on the host by default, and its containers reach
    host services listening on 0.0.0.0 through it. The isolated gateway mode (Docker Engine 28.0)
    assigns none, and with IPv6 off no IPv6 gateway takes its place."""
    internal = COMPOSE["networks"]["internal"]
    assert internal["driver_opts"] == {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}
    assert internal["enable_ipv6"] is False


@pytest.mark.parametrize("service", BEHIND_THE_PROXY)
def test_every_service_behind_the_proxy_is_told_to_use_it(service: str) -> None:
    environment = SERVICES[service]["environment"]
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        assert environment[key] == PROXY_URL, key
    for key in ("NO_PROXY", "no_proxy"):
        assert "ntfy" in environment[key].split(","), key


# The private, internal and special-use ranges standard mode must deny before
# any allow (brief: "At minimum" this list; a `dst` ACL, checked on the IP
# Squid actually connects to, so a name that resolves to one is caught too).
STANDARD_DENIED_RANGES = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "192.0.0.0/24", "198.18.0.0/15",
    "224.0.0.0/4", "240.0.0.0/4",
    "::1/128", "::/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8",
]


def test_both_egress_mode_files_exist() -> None:
    assert (DEPLOY / "proxy" / "mode-standard.conf").is_file()
    assert (DEPLOY / "proxy" / "mode-strict.conf").is_file()


def test_standard_mode_denies_every_private_and_special_range_before_any_allow() -> None:
    conf = config_lines("proxy/mode-standard.conf")
    dst_acl_lines = [line for line in conf if line.startswith("acl") and " dst " in line]
    dst_acl_names = {line.split()[1] for line in dst_acl_lines}
    dst_acl_text = "\n".join(dst_acl_lines)
    for cidr in STANDARD_DENIED_RANGES:
        assert cidr in dst_acl_text, cidr

    rules = [line for line in conf if line.startswith("http_access")]
    allow_indexes = [i for i, line in enumerate(rules) if line.startswith("http_access allow")]
    assert allow_indexes, "standard mode has no allow rule"
    deny_private_indexes = [
        i for i, line in enumerate(rules)
        if line.startswith("http_access deny") and any(name in line.split() for name in dst_acl_names)
    ]
    assert deny_private_indexes, "no http_access deny rule references the private-range acl"
    assert all(i < allow_indexes[0] for i in deny_private_indexes)


def test_standard_mode_allows_only_ports_80_and_443() -> None:
    conf = config_lines("proxy/mode-standard.conf")
    port_acl_lines = [line for line in conf if line.startswith("acl") and " port " in line]
    ports: set[str] = set()
    names = []
    for line in port_acl_lines:
        names.append(line.split()[1])
        ports.update(line.split(" port ", 1)[1].split())
    assert ports == {"80", "443"}
    rules = [line for line in conf if line.startswith("http_access")]
    assert any(
        line.startswith("http_access deny !") and line.split("!", 1)[1] in names
        for line in rules
    ), "no rule restricts standard mode to the allowed ports"
    assert "http_access allow all" in rules


def test_strict_mode_has_no_allow_all_and_still_allows_only_connect_to_listed_hosts() -> None:
    conf = config_lines("proxy/mode-strict.conf")
    rules = [line for line in conf if line.startswith("http_access")]
    assert rules == [
        "http_access deny !CONNECT",
        "http_access deny !https_port",
        "http_access allow allowed_hosts",
        "http_access deny all",
    ]
    assert "http_access allow all" not in rules
    assert 'acl allowed_hosts dstdomain -n "/etc/squid/allowed-domains.txt"' in conf
    assert "acl https_port port 443" in conf
    assert "acl CONNECT method CONNECT" in conf


def test_the_egress_proxy_mounts_both_static_files_and_the_chosen_mode_file() -> None:
    volumes = SERVICES["egress-proxy"]["volumes"]
    assert volumes[0] == "./proxy/squid.conf:/etc/squid/squid.conf:ro"
    assert volumes[1] == "./proxy/allowed-domains.txt:/etc/squid/allowed-domains.txt:ro"
    mode_mount = volumes[2]
    assert mode_mount["source"] == "./proxy/mode-${EGRESS_MODE:-standard}.conf"
    assert mode_mount["target"] == "/etc/squid/mode.conf"
    assert mode_mount["read_only"] is True
    assert mode_mount["bind"]["create_host_path"] is False


def test_the_default_egress_mode_is_standard() -> None:
    """Unset EGRESS_MODE must mean standard, both in Compose's own default and in the example env."""
    assert "${EGRESS_MODE:-standard}" in COMPOSE_TEXT
    assert "EGRESS_MODE" not in set(re.findall(r"\$\{([A-Z0-9_]+):\?", COMPOSE_TEXT))
    assert env_example().get("EGRESS_MODE") == "standard"


def test_the_proxy_config_includes_only_its_own_mode_file() -> None:
    """The image's conf.d/debian.conf allows every local network; only the mode split may be included."""
    assert [line for line in config_lines("proxy/squid.conf") if line.startswith("include")] == [
        "include /etc/squid/mode.conf"
    ]


def test_the_proxy_keeps_the_file_descriptor_cap_the_image_sets() -> None:
    """The image sets it in conf.d/rock.conf, which this config does not include."""
    assert "max_filedescriptors 1024" in config_lines("proxy/squid.conf")


def test_the_proxy_logs_to_the_file_the_image_follows() -> None:
    """Squid opens its logs after dropping to the `proxy` user, and a log it cannot open stops it
    at start; a stdio: target on the container's output is such a log. The image's entrypoint
    follows /var/log/squid/access.log onto the container output instead."""
    assert [line for line in config_lines("proxy/squid.conf") if "stdio:" in line] == []


def test_the_allowlist_is_bare_host_names_and_reaches_the_ntfy_upstream() -> None:
    """Only the active (uncommented) lines count: strict mode ships one commented provider
    block per row of the README's table, for the owner to uncomment as needed."""
    hosts = config_lines("proxy/allowed-domains.txt")
    assert hosts
    assert [host for host in hosts if not HOSTNAME.match(host)] == []
    assert len(hosts) == len(set(hosts))
    assert "ntfy.sh" in hosts


def test_the_ingress_forwards_the_two_listeners_to_their_services() -> None:
    config = config_lines("ingress/haproxy.cfg")
    assert "mode tcp" in config
    assert sorted(line for line in config if line.startswith("bind ")) == ["bind :8080", "bind :9119"]
    servers = sorted(line.split()[2] for line in config if line.startswith("server "))
    assert servers == ["hermes-serve:9119", "ntfy:80"]
    assert SERVICES["ingress"]["volumes"] == ["./ingress/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro"]


def test_the_ingress_serves_no_stats_page() -> None:
    """A stats listener would publish HAProxy's own status page through the ingress's ports."""
    assert [line for line in config_lines("ingress/haproxy.cfg") if line.startswith("stats")] == []


def test_hermes_serve_listens_on_its_container_network_for_the_ingress() -> None:
    """The Tailscale IP exists only on the host; binding it inside the container fails."""
    command = SERVICES["hermes-serve"]["command"]
    assert command[command.index("--host") + 1] == "0.0.0.0"


def test_ntfy_knows_the_url_phones_subscribe_with() -> None:
    """ntfy refuses an upstream without a base URL, and hashes the base URL into iOS poll requests."""
    environment = SERVICES["ntfy"]["environment"]
    assert environment["NTFY_BASE_URL"].startswith("http://${TAILSCALE_IP:?")
    assert environment["NTFY_BASE_URL"].endswith(":${NTFY_PORT:-8080}")
    assert environment["NTFY_UPSTREAM_BASE_URL"] == "${NTFY_UPSTREAM_BASE_URL:-https://ntfy.sh}"


@pytest.mark.parametrize("service", CONTROLLERS)
def test_both_controllers_mount_the_plugin_read_only_and_the_docker_socket(service: str) -> None:
    volumes = SERVICES[service]["volumes"]
    assert PLUGIN_MOUNT in volumes
    assert DOCKER_SOCKET in volumes
    assert SERVICES[service]["environment"]["HERMES_HOME"] == "/opt/data"


def test_ntfy_gets_no_docker_socket_and_denies_by_default() -> None:
    ntfy = SERVICES["ntfy"]
    assert DOCKER_SOCKET not in ntfy.get("volumes", [])
    assert ntfy["environment"]["NTFY_AUTH_DEFAULT_ACCESS"] == "deny-all"


def test_every_image_is_pinned_by_digest() -> None:
    """03 section 9: "Pin image digests; do not use mutable ntfy/Caddy/Hermes tags"."""
    unpinned = {name: service["image"] for name, service in SERVICES.items()
                if not PINNED_IMAGE.match(service["image"]) or ":latest@" in service["image"]}
    assert unpinned == {}


def test_both_controllers_run_the_same_image() -> None:
    assert SERVICES["hermes-serve"]["image"] == SERVICES["hermes-gateway"]["image"]


def test_there_are_two_profiles() -> None:
    assert PROFILES == ["concierge", "specialist-template"]


@pytest.mark.parametrize("name", PROFILES)
def test_each_profile_requires_manual_approval_with_the_1800_second_timeout(name: str) -> None:
    assert profile(name)["approvals"] == {"mode": "manual", "timeout": 1800, "cron_mode": "deny", "unattended_mode": "deny"}


@pytest.mark.parametrize("name", PROFILES)
def test_each_profile_runs_tools_in_an_offline_docker_sandbox(name: str) -> None:
    terminal = profile(name)["terminal"]
    assert terminal["backend"] == "docker"
    assert terminal["docker_network"] is False
    assert terminal["docker_forward_env"] == []
    assert terminal["docker_shared_container_key"] == ""


@pytest.mark.parametrize("name", PROFILES)
def test_each_profile_has_a_soul(name: str) -> None:
    assert (DEPLOY / "profiles" / name / "SOUL.md").read_text(encoding="utf-8").strip()


def test_only_the_concierge_multiplexes_the_gateway() -> None:
    assert profile("concierge")["gateway"] == {"multiplex_profiles": True}
    assert "gateway" not in profile("specialist-template")


@pytest.mark.parametrize("name", PROFILES)
def test_each_profile_enables_the_plugin(name: str) -> None:
    """Hermes loads a user plugin only when the active home's config.yaml enables it."""
    assert "ergates" in profile(name)["plugins"]["enabled"]


def test_the_concierge_holds_the_install_wide_push_settings_without_a_secret() -> None:
    """The concierge's config.yaml is the Hermes root's, where every hook and the sweep read ntfy.*."""
    ntfy = profile("concierge")["plugins"]["entries"]["ergates"]["settings"]["ntfy"]
    assert ntfy == {"server": "http://ntfy", "topic": "ergates-attention"}
    assert "entries" not in profile("specialist-template")["plugins"]


def test_there_are_templates_and_each_is_one_the_accept_route_serves() -> None:
    assert TEMPLATES
    for template_id in TEMPLATES:
        template = load_template(TEMPLATES_DIR, template_id)
        assert template["enabled_toolsets"], template_id
        assert "{{" not in template["soul"], template_id


def test_a_readonly_labeled_template_never_grants_file_writes() -> None:
    """`file` includes write_file and patch at the pin: a template whose id
    claims read-only access must not pin that toolset, or the one approval
    surface the operator sees would call a writer read-only."""
    for template_id in TEMPLATES:
        if "readonly" in template_id:
            template = load_template(TEMPLATES_DIR, template_id)
            assert "file" not in template["enabled_toolsets"], template_id


def test_the_concierge_proposes_exactly_the_shipped_templates() -> None:
    soul = (DEPLOY / "profiles" / "concierge" / "SOUL.md").read_text(encoding="utf-8")
    named = sorted(set(re.findall(r"`template_id: ([a-z0-9][a-z0-9_-]*)`", soul)))
    assert named == TEMPLATES


def test_the_templates_come_with_the_plugin_mount() -> None:
    """The templates sit in the plugin folder, which both controllers already mount. The plugin copies
    them into /opt/data/ergates/templates as the hermes user, so no service mounts them on its own:
    a bind mount below /opt/data/ergates would make Docker create that folder owned by root."""
    assert PLUGIN_MOUNT in SERVICES["hermes-serve"]["volumes"]
    for name, service in SERVICES.items():
        assert not [volume for volume in service.get("volumes", []) if "/opt/ergates/templates" in str(volume)], name


# Each live check of VERIFY.md and a phrase it must keep: the checks earlier
# work could not automate, so none may drop out unnoticed. V21-V23 (a green
# CI run on a real remote, and two app-only checks) were carried over from
# earlier reviews and did not fit any of V1-V20; V24 and V25 are app checks
# on a device too.
VERIFY_CHECKS = {
    "V1": "-k parse",
    "V2": "docker ps",
    "V3": "TCP_DENIED",
    "V4": "401",
    "V5": "ergates.install --check",
    "V6": "refusing to run as root",
    "V7": "plugins_dispatch.py:160-173",
    "V8": "post_llm_call",
    "V9": "locked",
    "V10": "replaces the first",
    "V11": "quiet hours",
    "V12": "ergates://chat/",
    "V13": "ergates-sealed-v1:",
    "V14": "five setup steps",
    "V15": "This tool is turned off for this agent.",
    "V16": "Save again",
    "V17": "no app is connected",
    "V18": "workspace",
    "V19": "Restore drill",
    "V20": "818c13be",
    "V21": "a real Git remote",
    "V22": "stay tappable",
    "V23": "queued_unsent",
    "V24": "jcenter()",
    "V25": "Airplane mode",
}


def test_verify_lists_every_live_check_with_a_place_for_its_result() -> None:
    sections = re.split(r"^### ", (DEPLOY / "VERIFY.md").read_text(encoding="utf-8"), flags=re.MULTILINE)[1:]
    assert [section.split(" ", 1)[0] for section in sections] == list(VERIFY_CHECKS)
    for section in sections:
        check = section.split(" ", 1)[0]
        assert VERIFY_CHECKS[check] in section, check
        assert "\nResult:" in section, check
