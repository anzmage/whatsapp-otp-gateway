# Native systemd deployment (Linux x86-64)

Alternative to Docker for shared experiment servers where installing a container daemon or modifying host networking is undesirable. This template uses its own pinned Node runtime; never replace another application's runtime. Run one instance only.

This is an operator-reviewed template, **not an automatic host installer**. Check host instructions, available paths/ports, resource budgets and existing services first. It does not change SSH, firewall, swap, existing services or package repositories.

## Layout

- `/opt/whatsapp-otp-gateway/releases/<commit>/`: root-owned immutable release and production dependencies.
- `/opt/whatsapp-otp-gateway/current`: symlink to the selected release.
- `/opt/whatsapp-otp-node/node-v22.22.0-linux-x64/`: dedicated official Node 22.22.0 distribution, verified against its official SHA-256 checksum.
- `/etc/whatsapp-otp-gateway/gateway.env`: root-owned mode-0600 configuration.
- `/var/lib/whatsapp-otp-gateway/`: mode-0700 state, owned by a dedicated `wotp` system user/group.
- `/etc/systemd/system/whatsapp-otp-gateway.service`: copy of the included unit.

Create `wotp` with a disabled login shell and no membership in other application groups. Keep the code/runtime root-owned and read-only to the service user. Install dependencies using `npm ci --omit=dev` from the committed lockfile in an isolated, resource-capped build environment. Do not give npm lifecycle scripts root access.

Minimum private environment file (generate a new random setup token locally on the host; do not log it):

```dotenv
SETUP_TOKEN=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
PUBLIC_URL=http://localhost:3000
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/whatsapp-otp-gateway
TRUST_PROXY=false
```

The placeholder token is intentionally rejected. The template pins an x86-64 runtime path; review/update the path and checksum when using another architecture or Node version.

After verifying the installed unit with `systemd-analyze verify`, use `systemctl daemon-reload` then `systemctl enable --now whatsapp-otp-gateway.service`. This reloads unit definitions; it does not restart unrelated services. The service runs without root privileges/capabilities, with a read-only host filesystem except its private data directory, isolated temporary files and limited process visibility. Node's JIT requires executable memory; do not blindly enable `MemoryDenyWriteExecute`.

Limits: 768 MiB memory high watermark, 1 GiB memory maximum, 256 MiB swap maximum, 40% of one CPU, 128 tasks, low CPU/I/O scheduling weights and a bounded restart policy. These protect a shared host but are **not VM-level isolation** or a guarantee that other workloads cannot be affected. Review the budget for your workload.

## Private access

Keep the listener on host loopback and use an SSH tunnel:

```sh
# Run on your own computer; replace YOUR_SSH_ALIAS with your configured server alias.
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3000:127.0.0.1:3000 YOUR_SSH_ALIAS
```

Open exactly `http://localhost:3000` in that computer's browser, matching `PUBLIC_URL`. Register the first owner using the setup token from the private host configuration, then add/pair your number yourself. Do not paste secrets into chat or issues. Port 3000 is not exposed publicly. If local port 3000 is occupied, choose another local port **and** update the configured PUBLIC_URL to that browser origin before restarting only this gateway.

For later public access, configure a reviewed HTTPS reverse proxy and exact HTTPS `PUBLIC_URL` in a separate deployment step. No wildcard CORS or direct public HTTP.

## Verification and maintenance

Check `/health`, the dashboard/assets, unauthenticated denial of `/docs/` and `/openapi.json`, and absence of a public bind on port 3000. `/health` proves only that the process is running. Test owner setup/login and WhatsApp pairing as separate user-directed actions; do not invent an owner or send OTPs during deployment verification.

Before/after deployment, compare **service status/PIDs/restart counters only** for existing protected workloads. Do not inspect their private state or credentials. This application must never read their data.

Before an upgrade: stop only this gateway, take an approved private consistent backup of the **whole** state directory, stage a new immutable release, switch `current`, and start this gateway. Do not run two writers. Code rollback alone is not guaranteed safe after future schema changes; see release-specific migration instructions.

For application logs use `journalctl -u whatsapp-otp-gateway.service` privately. Do not publish pairing data, recipient details, request bodies or keys. Rotate the password/keys via the UI when appropriate. Gateway shutdown is `systemctl stop whatsapp-otp-gateway.service`; do not stop other services or remove state directories as a troubleshooting shortcut.
