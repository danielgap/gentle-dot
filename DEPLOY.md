# Deploy notes — dot.granlenceria.es (local, not upstream)

Local deployment additions for this server. Not part of upstream gentle-dot.

## What runs

Max-power mode (explicit user decision 2026-10-09): the agent has full read/write
on the shop docroot and SQL access to the PrestaShop database, scoped as tightly
as that allows.

```sh
# Build order matters: Dockerfile.deploy layers on the base image.
docker build -t gentle-dot-base:local .
docker compose -f compose.deploy.yml up -d --build
```

```
browser → nginx (HestiaCP :443) → https://127.0.0.1:4443 → caddy-docker-proxy → gentle-dot:4317
```

- Domain: https://dot.granlenceria.es (HestiaCP template: dockerproxy)
- Image: `gentle-dot:deploy` (upstream build + `mariadb-client`), container `gentle-dot-gentle-dot-1`
- Data volume: `gentle-dot_dot-home` (conversations, memory, token, agent login, ~/.my.cnf)
- **Workspace (`GENTLE_DOT_WORKSPACE=/home/dot/site`)**: bind mount of the live
  docroot `/home/ragarapa/web/granlenceria.es/public_html`, read-write.
  Agent uid 1001 == host user `ragarapa`, so file ownership stays consistent.
  The shop's `AGENTS.md` (PrestaShop rules, cache safety) is auto-loaded as
  workspace instructions.
- **Database**: `ragarapa_presta_b` via the bind-mounted `/run/mysqld` socket dir
  (no bind-address change, no MariaDB restart, no network exposure). Dedicated
  user `gentledot`@`localhost` — ALL on `ragarapa_presta_b` only — with
  credentials in the volume at `/home/dot/.my.cnf` (0600, owned by dot).
  Plain `mariadb`/`mysql` works with no flags.
- Model: glm-5.3 via `zai` key injected into the engine's auth.json;
  defaultModel/defaultProvider/defaultThinkingLevel set in engine settings.json.
- Allowed origins: https://dot.granlenceria.es only.

## Ops

```sh
# status / logs
docker compose -f compose.deploy.yml ps
docker logs gentle-dot-gentle-dot-1

# health (public, through the full chain)
curl -s https://dot.granlenceria.es/health

# access token
docker exec gentle-dot-gentle-dot-1 cat /home/dot/.gentle-dot/token

# rotate the DB password: ALTER USER on MariaDB, then rewrite /home/dot/.my.cnf
# in the container (keep 0600, uid 1001).

# update
git pull --ff-only && docker build -t gentle-dot-base:local . \
  && docker compose -f compose.deploy.yml up -d --build
```

## Verified (2026-10-09)

- E2E chat turn through the full chain answered by GLM-5.3.
- Agent itself edited a file in `public_html/calculadora/` and queried
  `ps_product` (858 rows) through the socket — proof in the engine session log.

## Git rollback safety (default behavior)

The docroot is a server-local git repo (no remotes; never push). The agent commits
its work units as `gentle-dot` following the mandatory discipline in the shop's
`AGENTS.md` (scoped adds, conventional commits, no `git add -A`, no `reset --hard`).
Host baseline snapshot: `e88dc2ce` (2026-10-09). Access: ACL `u:ragarapa:rwx`
(recursive + default) on `.git/`; repo-local user.name/email were removed so host
(root global: danielgap) and engine (isolated HOME global: gentle-dot) identities
do not collide. `safe.directory /home/dot/site` is set in the engine's HOME.

DB rollback: daily dump cron `15 4 * * * /root/containers/gentle-dot/bin/db-dump.sh`
→ `/home/ragarapa/web/granlenceria.es/backups-db/presta_b-*.sql.gz` (7 kept,
outside the docroot, 0600). Bulk SQL still requires a targeted pre-dump per AGENTS.md.

## Two-locks hardening (active since 2026-10-09)

Basic Auth at nginx, in front of the access token:
- Include: `/home/ragarapa/conf/web/dot.granlenceria.es/nginx.ssl.conf_auth`
  (HestiaCP `nginx.ssl.conf_*` custom include — survives domain rebuilds)
- Credentials: `/home/ragarapa/conf/web/dot.granlenceria.es/.htpasswd-dot`
  (apr1 hash; rotate with `openssl passwd -apr1 'new'`, format `user:hash`, no reload needed)

## S25.8 server mode (since upstream 535e7f7)

Upstream `#45` changed the container architecture: the **daemon runs as root**, the engine still
runs as `dot` (uid 1001 — site mount ownership unchanged), and a `dotmcp` system user runs
connector servers. Consequences for this deployment:

- `Dockerfile.deploy` no longer switches USER: the upstream entrypoint owns privilege dropping.
- The daemon token (`<data>/token`) is now **root-owned 0600** by design (the engine must not
  read it), so the dot-telegram bridge container runs as `user: "0:0"` to read it from the
  read-only shared volume.
- **Web PIN**: connector changes and sending actions ask for a PIN set on first use in the
  browser (`<data>/web-pin.json`; delete that file to reset it). Chat still uses the access key.
- Connector secrets are off unless `GENTLE_DOT_SECRETS_KEY` is set; we use no connectors, so it
  stays unset.

## Safety reminders

- This agent can break the live store (files + DB). Before risky work, snapshot:
  `mariadb ragarapa_presta_b > backup.sql` per-table, or copy files.
- Never run `docker compose down -v` (drops conversations, memory, login, .my.cnf).
- Optional hardening still open: Basic Auth at nginx in front of the token.
