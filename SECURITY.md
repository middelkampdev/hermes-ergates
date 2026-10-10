# Security Policy

## Supported versions

Only the latest release of Ergates is supported with security fixes. Older releases do not receive backports; upgrade to the latest release before reporting an issue that a newer release might already fix.

## Reporting a vulnerability

Report a vulnerability privately through GitHub, using either:

- the **Report a vulnerability** button on this repository's Security tab, or
- the [security advisory form](https://github.com/middelkampdev/hermes-ergates/security/advisories/new) directly.

Do not report a security issue in a public GitHub issue, discussion, or pull request.

### What to include

- What you found, and where (file, endpoint, screen, or component).
- Steps to reproduce it, including any request, input, or configuration needed.
- What you'd expect to happen instead, and the impact if it were exploited.
- The app version or commit you tested against, and the platform (iOS, Android, or server).

### What to expect

This is a one-person project, so there's no guaranteed response time — reports are handled as soon as possible. You'll get an acknowledgement through the advisory thread, and a fix is released and disclosed once it's ready, coordinated with you where that's practical.

### Store-release secrets

The secrets used to sign and publish store builds (see [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md)) live only in the protected `app-stores` GitHub environment, gated to release tags. They are never committed to the repository. If you believe one of these secrets has leaked, report it privately through the channels above rather than filing a public issue.
