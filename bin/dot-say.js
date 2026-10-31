#!/usr/bin/env node
/**
 * dot-say — inject a scheduled turn into the gentle-dot conversation.
 *
 * Ops tool: meant to run as root via `docker exec` (needs the daemon token at
 * /home/dot/.gentle-dot/token, root 0600 — the engine user cannot read it, and
 * deliberately so: the agent must not inject turns into itself).
 *
 * Usage (inside the container):
 *   dot-say.js "<prompt>" [timeout_minutes]
 *
 * Connects as a WebSocket client (protocol v1: hello -> ready -> send),
 * waits for the first message_done, prints the agent's reply to stdout.
 * Exit codes: 0 ok · 1 protocol/timeout error · 2 usage · 75 temp failure
 * (daemon refused: busy/agent_unavailable — retry later) · 76 bad token.
 */
'use strict';

const fs = require('node:fs');

const URL_ = process.env.DOT_SAY_WS || 'ws://127.0.0.1:4317/ws';
const TOKEN_FILE = process.env.DOT_SAY_TOKEN_FILE || '/home/dot/.gentle-dot/token';
const SEND_REFUSALS = new Set(['no_account', 'agent_unavailable', 'command_failed', 'unsupported']);

function die(code, msg) {
    process.stderr.write(`dot-say: ${msg}\n`);
    process.exit(code);
}

const prompt = process.argv[2];
if (!prompt) die(2, 'usage: dot-say.js "<prompt>" [timeout_minutes]');
const timeoutMs = Math.max(1, parseInt(process.argv[3] || '10', 10) || 10) * 60_000;

let token;
try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
    die(76, `cannot read daemon token at ${TOKEN_FILE} (run as root via docker exec).`);
}

const ws = new WebSocket(URL_);
let gotReady = false;
let sent = false;
let finalText = null;
let deltas = '';

const killTimer = setTimeout(() => {
    try { ws.close(); } catch {}
    die(1, `timeout after ${timeoutMs / 60000} min waiting for the agent's reply.`);
}, timeoutMs);

function finish(code, msg, text) {
    clearTimeout(killTimer);
    try { ws.close(); } catch {}
    if (code === 0 && text !== undefined) process.stdout.write(text + '\n');
    if (msg && code !== 0) process.stderr.write(`dot-say: ${msg}\n`);
    process.exit(code);
}

ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, protocol: 1 }));

ws.onerror = (e) => {
    if (!gotReady) die(1, `cannot reach the daemon at ${URL_}: ${e.message || 'connection error'}`);
};

ws.onclose = () => {
    if (finalText === null) {
        finish(sent ? 1 : 1, sent ? 'connection closed before the reply finished.' : 'connection closed before ready.');
    }
};

ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data.toString()); } catch { return; }

    switch (msg.type) {
        case 'ready':
            gotReady = true;
            ws.send(JSON.stringify({ type: 'send', text: prompt }));
            sent = true;
            return;
        case 'message_delta':
            if (sent) deltas += msg.delta || '';
            return;
        case 'message_done': {
            if (!sent || finalText !== null) return; // not ours / already done
            finalText = msg.error ? null : (msg.text !== undefined ? msg.text : deltas);
            if (msg.error) finish(1, `agent turn failed: ${msg.error}`);
            finish(0, undefined, finalText);
            return;
        }
        case 'error': {
            if (!gotReady && msg.code === 'unauthorized') die(76, `daemon refused the token: ${msg.message}`);
            if (SEND_REFUSALS.has(msg.code)) finish(75, `daemon refused the send (${msg.code}): ${msg.message}`);
            finish(1, `daemon error (${msg.code}): ${msg.message}`);
            return;
        }
        default:
            return; // agent_state, activity, ask, toast... not ours to answer
    }
};
