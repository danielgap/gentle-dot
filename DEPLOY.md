# Deploy notes — dot.granlenceria.es (local, not upstream)

Local deployment additions for this server. Not part of upstream gentle-dot.

## What runs

`docker compose -f compose.deploy.yml up -d --build`

The container joins the external `web` network and is routed by the existing
caddy-docker-proxy (`hestia-docker`) via labels — same pattern as
`dashboard_granlenceria`. No host ports are bound.

```
browser → nginx (HestiaCP :443) → https://127.0.0.1:4443 → caddy-docker-proxy → gentle-dot:4317
```

- Domain: https://dot.granlenceria.es (HestiaCP template: dockerproxy)
- Data volume: `gentle-dot_dot-home` (conversations, memory, token, agent login)
- Landings workspace: host `./landings` → container `/home/dot/landings`
  (`GENTLE_DOT_WORKSPACE`). Container user `dot` is **uid 1001** (uid 1000 is
  `node` in the base image), so the host dir must stay owned by 1001:1001.
- Model accounts: none baked in. Sign in from the browser: Accounts or `/login`.

## Ops

```sh
# status / logs
docker compose -f compose.deploy.yml ps
docker logs gentle-dot-gentle-dot-1

# health (public, through the full chain)
curl -s https://dot.granlenceria.es/health

# access token
docker exec gentle-dot-gentle-dot-1 cat /home/dot/.gentle-dot/token

# update
git pull --ff-only && docker compose -f compose.deploy.yml up -d --build

# landings on the host
ls -l /root/containers/gentle-dot/landings
```

## Optional hardening (not done)

- Basic Auth at nginx in front of the token (two locks).
- Opt out of companion-package telemetry:
  `docker exec gentle-dot-gentle-dot-1 gentle-ai telemetry disable`.
