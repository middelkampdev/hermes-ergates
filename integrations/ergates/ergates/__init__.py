"""The Ergates integration for Hermes Agent (the plugin's entry point is ``../__init__.py``)."""

# Same value as `version` in ../plugin.yaml and ../pyproject.toml; GET /health reports it.
__version__ = "0.2.0"

# What the app may rely on in the routes and bodies, apart from the plugin version. A route or body change
# the app relies on raises API_LEVEL. MIN_API_LEVEL, the oldest level this plugin still serves, follows at
# least one release later, so an app built for the previous level keeps working for one release.
# GET /health reports both.
API_LEVEL = 2
MIN_API_LEVEL = 1
