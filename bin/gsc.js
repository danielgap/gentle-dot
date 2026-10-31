#!/usr/bin/env node
/**
 * gsc — Search Console CLI for the gentle-dot agent.
 *
 * Reads data from the granlenceria dashboard backend API (which owns the
 * Google service-account credentials). Live passthrough: every query hits
 * Google Search Console at call time; nothing is cached except the JWT.
 *
 * Config: ~/.dashboard.env (0600, owned by dot)
 *   DASHBOARD_API_URL     e.g. http://dashboard_granlenceria-frontend-1/api
 *   DASHBOARD_USERNAME
 *   DASHBOARD_PASSWORD
 *
 * Token cache: ~/.cache/gsc-token.json (refreshed near expiry or on 401).
 * The API allows only 5 logins / 15 min per IP, so tokens are reused.
 *
 * Usage:
 *   gsc sites
 *   gsc status
 *   gsc analytics --site <siteUrl> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                 [--dims date,query,page,country,device] [--limit N] [--start-row N]
 *
 * Exit codes: 0 ok · 1 API error · 2 config/usage error · 3 auth error
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const ENV_FILE = path.join(HOME, '.dashboard.env');
const TOKEN_FILE = path.join(HOME, '.cache', 'gsc-token.json');
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const ALLOWED_DIMS = ['date', 'query', 'page', 'country', 'device'];

function die(code, msg) {
    process.stderr.write(`gsc: ${msg}\n`);
    process.exit(code);
}

function loadEnv() {
    let raw;
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        die(2, `config not found or unreadable at ${ENV_FILE}. Ask the maintainer to (re)provision it.`);
    }
    const env = {};
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    if (!env.DASHBOARD_API_URL || !env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
        die(2, `incomplete config at ${ENV_FILE}: need DASHBOARD_API_URL, DASHBOARD_USERNAME, DASHBOARD_PASSWORD.`);
    }
    return env;
}

function readCachedToken() {
    try {
        const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        return typeof t.token === 'string' && Number.isFinite(t.expiresAtMs) ? t : null;
    } catch {
        return null;
    }
}

function writeCachedToken(token) {
    try {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(token), { mode: 0o600 });
    } catch (e) {
        process.stderr.write(`gsc: warning: could not cache token (${e.message}); continuing.\n`);
    }
}

async function login(env) {
    const res = await fetch(`${env.DASHBOARD_API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: env.DASHBOARD_USERNAME, password: env.DASHBOARD_PASSWORD }),
    });
    if (res.status === 429) {
        die(3, 'login rate-limited (5 per 15 min per IP). Reuse a cached token or retry later.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
        die(3, `login failed (${res.status}): ${body.error || 'unknown error'}`);
    }
    // JWTs here expire in 24h; decode exp without verifying (server verified it).
    let expiresAtMs = Date.now() + 24 * 60 * 60 * 1000;
    try {
        const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString('utf8'));
        if (payload.exp) expiresAtMs = payload.exp * 1000;
    } catch { /* keep default */ }
    const cached = { token: body.token, expiresAtMs };
    writeCachedToken(cached);
    return cached;
}

async function getToken(env, { forceRefresh = false } = {}) {
    const cached = forceRefresh ? null : readCachedToken();
    if (cached && cached.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS) return cached;
    return login(env);
}

async function api(env, pathname) {
    const { token } = await getToken(env);
    const res = await fetch(`${env.DASHBOARD_API_URL}${pathname}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
        const retry = await getToken(env, { forceRefresh: true });
        const res2 = await fetch(`${env.DASHBOARD_API_URL}${pathname}`, {
            headers: { Authorization: `Bearer ${retry.token}` },
        });
        return { status: res2.status, body: await res2.json().catch(() => ({})) };
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

function usage() {
    process.stderr.write(
        'usage: gsc sites\n' +
        '       gsc status\n' +
        '       gsc analytics --site <siteUrl> [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n' +
        '                     [--dims date,query,page,country,device] [--limit N] [--start-row N]\n'
    );
    process.exit(2);
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd) usage();

    // --- argument parsing (simple --key value / --key=value) ---
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        let a = args[i];
        if (!a.startsWith('--')) usage();
        let key = a.slice(2), val;
        const eq = key.indexOf('=');
        if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
        else { val = args[++i]; if (val === undefined) usage(); }
        opts[key] = val;
    }

    const env = loadEnv();

    if (cmd === 'sites' || cmd === 'status') {
        const { status, body } = await api(env, `/${cmd === 'sites' ? 'searchconsole/sites' : 'searchconsole/status'}`);
        if (status !== 200 || body.success === false) {
            die(1, `${cmd} failed (${status}): ${body.error || 'unknown error'}`);
        }
        process.stdout.write(JSON.stringify(cmd === 'sites' ? body : body, null, 2) + '\n');
        return;
    }

    if (cmd === 'analytics') {
        if (!opts.site) die(2, 'analytics requires --site <siteUrl> (run `gsc sites` to list them).');
        const from = opts.from || fmtDate(new Date(Date.now() - 28 * 864e5));
        const to = opts.to || fmtDate(new Date());
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRe.test(from) || !dateRe.test(to)) die(2, '--from/--to must be YYYY-MM-DD.');

        const dims = (opts.dims || 'date').split(',').map((d) => d.trim()).filter(Boolean);
        for (const d of dims) {
            if (!ALLOWED_DIMS.includes(d)) die(2, `unknown dimension "${d}". Allowed: ${ALLOWED_DIMS.join(', ')}.`);
        }
        const limit = Math.min(25000, Math.max(1, parseInt(opts.limit || '1000', 10)));
        if (Number.isNaN(limit)) die(2, '--limit must be a number.');
        let startRow;
        if (opts['start-row'] !== undefined) {
            startRow = Math.max(0, parseInt(opts['start-row'], 10));
            if (Number.isNaN(startRow)) die(2, '--start-row must be a number.');
        }

        const qs = new URLSearchParams({
            siteUrl: opts.site, startDate: from, endDate: to,
            dimensions: dims.join(','), rowLimit: String(limit),
        });
        if (startRow !== undefined) qs.set('startRow', String(startRow));

        const { status, body } = await api(env, `/searchconsole/analytics?${qs.toString()}`);
        if (status !== 200 || body.success === false) {
            die(1, `analytics failed (${status}): ${body.error || 'unknown error'}`);
        }
        process.stdout.write(JSON.stringify(body, null, 2) + '\n');
        return;
    }

    usage();
}

main().catch((e) => die(1, e.message));
