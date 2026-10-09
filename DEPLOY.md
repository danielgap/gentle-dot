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

## Safety reminders

- This agent can break the live store (files + DB). Before risky work, snapshot:
  `mariadb ragarapa_presta_b > backup.sql` per-table, or copy files.
- Never run `docker compose down -v` (drops conversations, memory, login, .my.cnf).
- Optional hardening still open: Basic Auth at nginx in front of the token.
