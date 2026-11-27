# Yoda documentation

[Back to the project README](../README.md)

## Using Yoda

| Guide | For | ภาษาไทย |
| --- | --- | --- |
| [Staff guide](guides/staff.md) | IT staff: to-do, tasks and AI drafts, work items, chat with the AI secretary, discussions and agendas, status, notifications, runners | [คู่มือเจ้าหน้าที่ IT](guides/staff.th.md) |
| [Requester guide](guides/requester.md) | People who ask IT for work: new requests, my requests, answering questions, accepting the delivery | [คู่มือผู้แจ้งคำขอ](guides/requester.th.md) |
| [Admin guide](guides/admin.md) | Administrators: System settings, secrets, environment locks, re-auth, change log, AI budget, email, LINE and Telegram, GitLab, runners, the fun switch, people, recovery | |

## Running Yoda

| Document | Contents |
| --- | --- |
| [Install and upgrade](guides/install.md) | `install.sh` and the signed bundle, the setup wizard step by step, the recovery kit, `/recovery`, `yoda-admin`, upgrading (also from an env-based install) |
| [Operations runbook](operations.md) | The reference: every setting and variable, Keycloak, backups and restore, GitLab, runners, channels, rotating secrets, troubleshooting |
| [Architecture](architecture.md) | The containers and services, and how they talk to each other |

## Building Yoda

| Document | Contents |
| --- | --- |
| [Development](development.md) | Running from source, tests, images, GitLab integration and runner reference, CI and releases |
| [Releasing](releasing.md) | Maintainers: the signing key and secrets, cutting a release on GitHub (Releases + GHCR), dry runs, an internal mirror |
| [CHANGELOG](../CHANGELOG.md) | Changes per release |
| [Design notes](design/) | Design refresh, installer proposal and verification, the fun touches |
