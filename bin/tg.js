#!/usr/bin/env node
/**
 * tg — send Telegram messages as the dot bot (helper for the gentle-dot agent).
 *
 * Reads /home/dot/.telegram.env (absolute: the engine has an isolated HOME):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_DANI / TELEGRAM_CHAT_RAQUEL
 *
 * Usage:
 *   tg send <dani|raquel|chat_id> <text...>        plain text, auto-split at 4096
 *   tg send-file <dani|raquel|chat_id> <path> [caption]
 *
 * Exit codes: 0 ok · 1 telegram API error · 2 usage/config error
 */
'use strict';

const fs = require('node:fs');

const ENV_FILE = process.env.TG_ENV_FILE || '/home/dot/.telegram.env';
const MAX_LEN = 4000; // Telegram hard limit is 4096; leave headroom

function die(code, msg) {
    process.stderr.write(`tg: ${msg}\n`);
    process.exit(code);
}

function loadEnv() {
    let raw;
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        die(2, `config not found at ${ENV_FILE}. Ask the maintainer to (re)provision it.`);
    }
    const env = {};
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    if (!env.TELEGRAM_BOT_TOKEN) die(2, `TELEGRAM_BOT_TOKEN missing in ${ENV_FILE}.`);
    return env;
}

function resolveChat(env, who) {
    const named = { dani: env.TELEGRAM_CHAT_DANI, raquel: env.TELEGRAM_CHAT_RAQUEL };
    const lower = String(who).toLowerCase();
    if (named[lower]) return named[lower];
    if (/^-?\d+$/.test(who)) return who; // explicit chat id
    die(2, `unknown target "${who}". Use dani, raquel, or a numeric chat id.`);
}

/** Split into chunks under MAX_LEN, preferring newline boundaries. */
function split(text) {
    const out = [];
    let rest = String(text);
    while (rest.length > MAX_LEN) {
        let cut = rest.lastIndexOf('\n', MAX_LEN);
        if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length) out.push(rest);
    return out;
}

async function api(env, method, params) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
        die(1, `${method} failed (${res.status}): ${body.description || 'unknown error'}`);
    }
    return body.result;
}

async function sendFile(env, method, chat, path, caption) {
    const buf = fs.readFileSync(path); // throws if missing
    const fd = new FormData();
    fd.set('chat_id', chat);
    if (caption) fd.set('caption', caption.slice(0, 1024));
    fd.set((method === 'sendDocument' ? 'document' : 'photo'), new Blob([buf]), path.split('/').pop());
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        body: fd,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
        die(1, `${method} failed (${res.status}): ${body.description || 'unknown error'}`);
    }
}

function usage() {
    process.stderr.write(
        'usage: tg send <dani|raquel|chat_id> <text...>\n' +
        '       tg send-file <dani|raquel|chat_id> <path> [caption]\n'
    );
    process.exit(2);
}

async function main() {
    const [cmd, who, ...rest] = process.argv.slice(2);
    if (!cmd || !who) usage();
    const env = loadEnv();
    const chat = resolveChat(env, who);

    if (cmd === 'send') {
        const text = rest.join(' ').trim();
        if (!text) usage();
        for (const chunk of split(text)) {
            await api(env, 'sendMessage', { chat_id: chat, text: chunk });
        }
        process.stdout.write(`sent ${split(text).length} message(s) to ${who} (${chat})\n`);
        return;
    }

    if (cmd === 'send-file') {
        const [path, ...cap] = rest;
        if (!path) usage();
        await sendFile(env, 'sendDocument', chat, path, cap.join(' '));
        process.stdout.write(`sent file ${path} to ${who} (${chat})\n`);
        return;
    }

    usage();
}

main().catch((e) => die(1, e.message));
