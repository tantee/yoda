# Install and upgrade

[All guides](../README.md)

How to install Yoda on a server, finish the setup wizard, keep a way back in, and upgrade. This guide walks the
common path; every detail and edge case is in the [operations runbook](../operations.md). Hostnames here are
placeholders (`portal.example.org`, `sso.example.org`); use your own. Releases are published on
[GitHub Releases](https://github.com/tantee/yoda/releases), with the images on `ghcr.io/tantee/yoda`.

- [Before you start](#before-you-start)
- [1. Install the release](#1-install-the-release)
- [2. The setup wizard](#2-the-setup-wizard)
- [3. After setup](#3-after-setup)
- [Recovery](#recovery)
- [yoda-admin commands](#yoda-admin-commands)
- [Upgrading](#upgrading)
- [For maintainers](#for-maintainers)

## Before you start

- A Linux host with about 10 GB free, and a deploy user (with sudo, if the tools below still need installing).
  The **requirements** below are checked by `install.sh`, which offers to install what is missing.
- A Keycloak realm with a client for the portal and a staff group
  ([runbook, section 2](../operations.md#2-keycloak)).
- HTTPS in front of the portal: a reverse proxy with a certificate (set `YODA_TRUSTED_PROXY_HOPS=2` in `.env`),
  or the optional **built-in HTTPS proxy** that `install.sh --with-proxy` turns on (release 1.1.0 or later; below, and
  [runbook, section 4b](../operations.md#4b-built-in-https-proxy-optional)).
  The public URL must use `https://`. Plain `http://` is accepted only when the host is this machine: `localhost`
  or a `*.localhost` name, an address in `127.0.0.0/8`, or `::1`. Any other `http://` address (a LAN address or
  host name) is refused, because browsers allow the portal's Keycloak sign-in only over HTTPS or on localhost.
  When it refuses, the organisation step shows both ways forward: the SSH-tunnel command and how to put HTTPS in
  front. Until HTTPS is ready, run the wizard through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 <host>`, then open
  `http://127.0.0.1:3000/setup`).
- Optional: SMTP, a LINE Official Account, a Telegram bot, a GitLab bot account, AI provider keys. Each can be
  added later in System settings.

Every command below runs in the install directory. The runbook uses `dc` for the compose command with the right
files; define it once:

```bash
alias dc='docker compose --env-file .env --env-file release.env -f docker-compose.yml -f docker-compose.prod.yml'
```

## 1. Install the release

On the host, as the deploy user:

```bash
curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh | sh
```

That installs the latest release into `/srv/yoda` (the published `install.sh` names its own release, so the
one-liner never installs a newer one than the script it downloaded). Options go after `sh -s --`: a pinned release, another
directory, the built-in HTTPS proxy (below), `--yes` to answer every question with yes:

```bash
curl -fsSL https://github.com/tantee/yoda/releases/latest/download/install.sh |
  sh -s -- --version 1.2.0 --dir /srv/yoda --with-proxy --domain portal.example.org
```

**Requirements.** `install.sh` checks them before it downloads anything, names each one that is missing or too
old with the version it found and the version it needs, and offers to install them:

- Docker Engine 24+ and the Docker Compose plugin v2.24+, and a user who may run `docker`;
- `curl`, `tar`, `sha256sum` (or `shasum`) and `minisign` (it checks the release signature), plus `openssl` for
  `--cert-mode files`;
- about 10 GB free at the install directory (the warning names the free space and the path it checked).

On Debian and Ubuntu it offers to install what is missing: the tools with `apt` (minisign from `universe` on
Ubuntu, enabled when needed) and Docker from Docker's own apt repository (`docker-ce`, `docker-ce-cli`,
`containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin`; the key goes in `/etc/apt/keyrings`). The RHEL
family gets the same with `dnf` (minisign from EPEL). It uses sudo when you are not root, and stops clearly when
sudo is missing. Ubuntu's or Debian's own `docker.io` and `docker-compose-v2` can be older than Compose v2.24:
`install.sh` explains that and how to switch to Docker's packages, but never replaces them itself. On any other
system it prints the manual steps and exits.

It asks **once** for all of that, after printing every command the yes stands for: the package installs,
`software-properties-common` and `add-apt-repository universe` (Ubuntu, only if apt does not know minisign),
`epel-release` and `dnf-plugins-core` (RHEL family), downloading and installing Docker's GPG key (its
fingerprint checked when `gpg` is there) and repository file, `systemctl enable --now docker`, and
`usermod -aG docker` (the `docker` group is root-equivalent: whoever is in it controls the host). Before writing
anything Docker-related it checks that Docker's repository has a release for your system; an existing Docker
source (apt or `docker-ce.repo`, as on an upgrade) is used as it is, never doubled or changed, and if the Docker
setup fails it removes only the files that run added (packages may still be partly installed). The
question is asked on the terminal (also when piped: it reads and writes `/dev/tty`). `--yes` answers yes (the
plan is still printed). With no terminal and no `--yes` it stops and names the flag; it never assumes yes. sudo
that needs a password with no terminal to type it stops it too. The same goes for two more questions:

- **The docker group.** If you may not run `docker`, it offers to add you to the `docker` group (root-equivalent,
  as above). The rest of the same run uses the group through `sg docker`; log out and back in before you run
  `docker` or `dc` yourself (or run `install.sh` with sudo instead).
- **The install directory.** If `/srv/yoda` (or your `--dir`) cannot be created, it offers to create it with sudo
  and give it to you.

**What you trust.** Piping trusts GitHub's TLS for `install.sh` itself. Everything it downloads after that is
signature-checked: `SHA256SUMS` and `SHA256SUMS.minisig` for the release, the signature against the release key
built into the script, the signed trusted comment against the exact release, then the bundle against
`SHA256SUMS`. Any verification error stops it, before anything is unpacked. A download of `install.sh` cut short
runs nothing: the script only starts on its last line.

<details>
<summary>Prefer to verify install.sh itself?</summary>

Download `install.sh` and the checksums of a pinned release from GitHub Releases, check the signature, then run
it. Use the latest release from [the releases page](https://github.com/tantee/yoda/releases); `1.2.0` below is
an example.

```bash
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/install.sh
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS
curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS.minisig
out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
  printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.2.0' &&
  sha256sum --check --ignore-missing SHA256SUMS &&
  sh install.sh --version 1.2.0 --dir /srv/yoda
```

Each command runs only when the one before it passed: `minisign` checks the signature (`out=$(…) &&` keeps its
exit status), `grep` that the signed
trusted comment names this release (`Trusted comment: yoda release 1.2.0`; a different version means you
downloaded the wrong files), and `sha256sum` the checksum of `install.sh`. Nothing runs if any of them fails.
For another release, change the version in the URLs, the `grep` and `--version`. Run this way, `install.sh` uses
the `SHA256SUMS` next to it (checking the signature again, and its own checksum).

</details>

The key after `-P` is the Yoda release key, minisign key id `C73EF0AF404BAE84`. It is also in
[`keys/yoda-release.pub`](../../keys/yoda-release.pub) and built into `install.sh`
([verifying releases](../releasing.md#verifying-releases)).

After its checks, `install.sh` downloads the **signed release bundle** and verifies it as above. It refuses an
existing install. It then unpacks the bundle (compose files, `deploy.sh`, `.env.example`, the runbook), creates an empty
`.env` (mode `600`) and runs the first deploy. The images come from `ghcr.io/tantee/yoda`, which is public: no
`docker login` is needed (if a pull fails because the packages are not public yet, `install.sh` offers
`docker login ghcr.io`). The deploy runs exactly the images the release was built with: their digests are in the
signed bundle (`bundle.env`), and `deploy.sh` pins them in `release.env`. The deploy fills the
**bootstrap volume** (generated database password, storage keys, master key and setup token), runs the database
migrations, starts everything and prints the setup address.

**Built-in HTTPS proxy (optional).** With no reverse proxy on the network, let Yoda run one (Caddy, ports 80 and
443) and give it the name staff will open (its DNS name must lead to this host). It needs **release 1.1.0 or
later**, the first that ships it: `install.sh` refuses `--with-proxy` with an older `--version`. A host already
on an older release upgrades first, then turns the proxy on
([runbook 4b, "Turn it on later"](../operations.md#4b-built-in-https-proxy-optional)).

```bash
sh install.sh --version 1.2.0 --dir /srv/yoda --with-proxy --domain portal.example.org
```

The certificate comes from one of three places, `--cert-mode`:

- `internal` (the default): Caddy's own certificate authority. The deploy copies its root certificate (public, no
  key) to `/srv/yoda/proxy/root.crt`; install it as a trusted root on every staff PC (a Windows Group Policy, a
  macOS profile, `update-ca-certificates` on Linux; Firefox on Linux does not read the system store and needs its
  own import, or the `Certificates` enterprise policy). The steps per system are in
  [runbook 4b](../operations.md#certificate-modes). Its root is trusted for every site, not only the portal: where
  the organisation has its own CA, prefer `files`.
- `files`: the organisation's certificate, `--cert <chain.pem> --key <key.pem>` (copied to `proxy/certs/`). With
  `openssl` on the host, `install.sh` checks that it names the domain, matches the key and has not expired.
- `acme`: Let's Encrypt, `--acme-email <address>`, only when the host is reachable from the internet on ports 80
  and 443 under that name (other ports are refused). `--acme-staging` makes a trial certificate from Let's
  Encrypt's staging CA first.

The deploy then prints `https://portal.example.org/setup`, and sets the trusted proxy hops (2) by itself. Keep one
encrypted, offline copy of the proxy's certificate volume with the recovery kit, as the runbook says. Without `--with-proxy`, nothing about the proxy is installed
or started.

Options: `--version`, `--dir`, `--yes`, `--base-url` (another file server), `--image-prefix` (another registry
path), `--no-login`. **Internal mirror:** a host that cannot reach GitHub installs from a copy inside the network with
`--base-url 'https://files.example.org/yoda/releases/{version}/' --image-prefix registry.example.org/group/yoda`
(the mirror's `install.sh` installs its own release; with the repository's copy, which names none, add
`--version 1.2.0`: a mirror has no "latest")
(a registry mirror of the images; `install.sh` asks for a `docker login` to it), see
[releasing, internal mirror](../releasing.md#internal-mirror). Nothing is required in `.env` for a standard install. To use an external Postgres or S3, or to fix settings from outside the
UI, see the runbook ([section 4, "Advanced"](../operations.md#4-first-install)).

## 2. The setup wizard

Open `https://portal.example.org/setup`. The wizard is in Thai by default; switch to English at the top right.

**Setup token.** Paste the token printed on the host:

```bash
dc exec core yoda-admin setup-token
```

It is valid for 24 hours, single use, and also appears in `dc logs core`. The page allows five wrong tries per 15
minutes.

![Enter the setup token](../images/setup-token.webp)

**Step 1 · Organisation.** The organisation name (Thai, optional English), a line under the menu, the default
language and the **public URL** of the portal. Check the detected URL: it is used in links, emails and the Keycloak
redirect.

![Organisation and web address](../images/setup-organisation.webp)

**Step 2 · Break-glass admin.** A local account for `/recovery`, used only when Keycloak sign-in fails. Choose a
username and a strong password (14+ characters), scan the QR code with an authenticator app and enter its code
(the authenticator is optional only when both the public URL and the address in your browser are `localhost`).

![Create the break-glass admin (QR code and key hidden in this screenshot)](../images/setup-admin.webp)

**Step 3 · System check.** Checks the database, the pgvector extension, the file storage bucket and the job queue.
The storage and database values are set on the host and shown read-only.

![System check](../images/setup-check.webp)

Below the results, the **Built-in HTTPS proxy** card says whether Yoda's own proxy is on, and if so its address,
certificate mode and the certificate it presents (issuer, names, valid until). Off is normal when your own reverse
proxy provides HTTPS. Nothing on it can be changed here: the proxy is set on the host.

![The built-in proxy card](../images/setup-proxy.webp)

**Step 4 · Sign-in (Keycloak).** The issuer URL, client ID, optional internal JWKS URL and the staff group. Copy
the redirect URIs and web origin shown into the Keycloak client, then **Test connection**: the wizard checks
discovery, the keys and the client before it lets you on.

![Connect Keycloak](../images/setup-signin.webp)

**Steps 5–8 (optional).** Email (SMTP), LINE, Telegram, then GitLab, AI and backups. Each has a test button and can
be skipped and set later in **System settings**.

**Step 9 · Recovery kit.** Download the kit: one text file, `yoda-recovery-kit-<install id>.txt`, with the master
key, the break-glass username and its ten recovery codes, the bootstrap values (database password, storage keys) and
how to use them. **It is shown once.** Print it or put it in the organisation's password vault, off this server and
apart from the backups: anyone with the kit and a database backup can read every secret. Setup continues only once
you confirm you stored it.

![Download the recovery kit](../images/setup-kit.webp)

**Step 10 · Claim admin.** Sign in through Keycloak with your own account; you become the first administrator.
The wizard checks the whole sign-in round trip and that you are in the staff group. **Finish setup** closes the
wizard for good.

![Sign in to become the first administrator](../images/setup-claim.webp)

Through an SSH tunnel the wizard sees `http://127.0.0.1:3000` as the public URL: enter the real one in step 1, and
do the claim on the public URL (`dc exec core yoda-admin setup-token --new` gives a new token there; finished steps
are kept). See the [runbook, section 4](../operations.md#4-first-install).

## 3. After setup

- [ ] Set the AI budgets (**System settings → AI**, and each project's **AI budget** tab).
- [ ] Connect GitLab and its webhooks, and set up runners ([admin guide](admin.md)).
- [ ] Turn on the notification channels you configured.
- [ ] Copy the `backups` volume off the host on a schedule, and try a restore
      ([runbook, section 6](../operations.md#6-backups-and-restore)).
- [ ] Alert on the `core`, `portal` and `backup` containers turning unhealthy.

## Recovery

**Locked out of Keycloak** (wrong issuer or client, Keycloak down, no admin left): open
`https://portal.example.org/recovery` and sign in with the break-glass account (password plus an authenticator code,
or **Use a recovery code instead**, from the kit). Every sign-in notifies all admins.

![Break-glass sign-in](../images/recovery-signin.webp)

The recovery page shows the install state and lets you:

- **Sign-in (Keycloak)**: stage a new issuer, client or JWKS URL, test a real sign-in with it, then apply it. The
  previous values can be restored for 7 days.
- **Portal admins**: grant admin to a username (a username that has never signed in gets it at the first sign-in),
  or revoke it.
- **Break-glass account**: change the password, enrol a new authenticator, make new recovery codes.

![The recovery page: install state, sign-in, admins and the break-glass account](../images/recovery-status.webp)

Lost the break-glass password or authenticator: `dc exec core yoda-admin reset-break-glass` prints a temporary
password; the next sign-in sets a new password and authenticator. If the master key is wrong or missing, core starts
in recovery mode and `/recovery` offers a status-only view until the key is back
([runbook, section 11](../operations.md#11-troubleshooting)).

## yoda-admin commands

Run them on the host as `dc exec core yoda-admin <command>`. Redirect commands that print a recovery kit to a
private file: `(umask 077; dc exec -T core yoda-admin recovery-kit > yoda-recovery-kit.txt)`.

| Command | What it does |
| --- | --- |
| `setup-token [--new]` | Prints the setup token (a new one with `--new`) while setup is not finished |
| `status` | Setup state, master key, break-glass account and sign-in state |
| `create-break-glass [--username <u>]` | Creates the break-glass account on an install set up without the wizard; prints a temporary password once |
| `reset-break-glass [--username <u>]` | New temporary break-glass password; the authenticator is enrolled again after sign-in |
| `recovery-kit` | A new recovery kit on standard output; makes new recovery codes (the old ones stop working) |
| `rotate-master-key [--dry-run]` | New master key; the new recovery kit goes to standard output. Then `rotate-master-key --finish` once every core runs on it |
| `reset-master-key --yes` | The master key is lost for good: drops the secrets it cannot open, so they can be entered again |
| `recovery on` / `recovery off` | Forces maintenance mode: the portal shows only `/recovery` |

Rotation and lost keys in detail: [runbook, section 10](../operations.md#10-rotating-secrets).

## Upgrading

1. Read `CHANGELOG.md` for the release. The deploy never changes `.env`; add any new variable yourself (most new
   options are System settings now).
2. Take a backup: `dc run --rm backup --now`.
3. Get the new release's files and deploy it. On the host, in the install directory (`1.2.0` stands for the new
   version):

   ```bash
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/yoda-1.2.0.tar.gz
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS
   curl -fsSLO https://github.com/tantee/yoda/releases/download/v1.2.0/SHA256SUMS.minisig
   out=$(minisign -Vm SHA256SUMS -P RWSErktAr/A+x5Gvgr0x29wiu41FmYEVlJYoXyB6oJk4kvwQLOZs9O9j) &&
     printf '%s\n' "$out" | grep -Fx 'Trusted comment: yoda release 1.2.0' &&
     sha256sum --check --ignore-missing SHA256SUMS &&
     tar -xzf yoda-1.2.0.tar.gz --no-same-owner &&
     rm yoda-1.2.0.tar.gz SHA256SUMS SHA256SUMS.minisig &&
     YODA_VERSION=1.2.0 sh ops/deploy/deploy.sh
   ```

   As at install, each command runs only when the one before it passed, and the `grep` checks that the
   signature is for `1.2.0`. The bundle never holds `.env` or `release.env`, so unpacking it only replaces the compose files, `deploy.sh`
   and the runbook files. An internal GitLab mirror's **deploy** job does the same in one step. The deploy pulls
   the images, pins the version and the bundle's image digests in `release.env`, updates the bootstrap volume, runs the migrations (a failed
   migration stops before anything is replaced), starts the new containers and waits until the portal answers.
4. Check the portal. To roll back, deploy the previous version the same way: download, check and unpack its
   bundle, then deploy it ([runbook, rollback](../operations.md#5-upgrade-and-rollback)).

**From an env-based install** (one with a full `.env`, from before the setup wizard): upgrade the same way.
The `init` step copies the database password, storage keys and master key from `.env` into the bootstrap volume; core
imports the other values into System settings and marks setup done. Those values show **Set by environment** until
you delete their lines from `.env`. Then create the break-glass account, which such an install does not have yet:

```bash
dc exec core yoda-admin create-break-glass       # prints a temporary password once
# sign in at /recovery, set a new password, enrol the authenticator
(umask 077; dc exec -T core yoda-admin recovery-kit > yoda-recovery-kit.txt)   # store it off the host
```

Full upgrade and rollback notes: [runbook, section 5](../operations.md#5-upgrade-and-rollback).

## For maintainers

Releases are cut by pushing a `v<version>` tag; `.github/workflows/release.yml` builds the images, signs the
bundle and publishes the GitHub Release. The signing key, the repository secrets, the package visibility and the
release checklist are in [Releasing Yoda](../releasing.md).
