'use strict';

const vscode = require('vscode');

// ── Logging ─────────────────────────────────────────────────────────────────
// One "Skript Tools" output channel shared by every module. Created lazily so
// requiring this module from a plain node process (the tests) is harmless.

let channel = null;

function getChannel() {
    if (!channel) channel = vscode.window.createOutputChannel('Skript Tools');
    return channel;
}

function log(message) {
    const stamp = new Date().toISOString().slice(11, 23);
    getChannel().appendLine(`[${stamp}] ${message}`);
    console.log(`[skript] ${message}`);
}

function dispose() {
    if (channel) channel.dispose();
    channel = null;
}

module.exports = { log, getChannel, dispose };
