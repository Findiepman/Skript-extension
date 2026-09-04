'use strict';

const vscode = require('vscode');
const scanner = require('./scanner');
const settings = require('./settings');
const formatter = require('./formatter');
const variables = require('./providers/variables');
const functions = require('./providers/functions');
const navigation = require('./providers/navigation');
const diagnostics = require('./diagnostics');
const logger = require('./log');

// ── Activation ──────────────────────────────────────────────────────────────
// Each module exposes register(context) and owns its own disposables. The
// scanner must go first: every provider reads from scanner.index.

let formatterDisposable = null;

function activate(context) {
    scanner.register(context);

    variables.register(context);
    functions.register(context);
    navigation.register(context);
    diagnostics.register(context);

    formatterDisposable = formatter.register(context);

    // Settings are read live by their getters; only the formatter needs to be
    // re-registered when its toggle flips. Scan-setting changes are handled
    // inside the scanner (full rescan).
    context.subscriptions.push(
        settings.onDidChange(changed => {
            if (!changed.format) return;
            if (formatterDisposable) formatterDisposable.dispose();
            formatterDisposable = formatter.register(context);
        })
    );

    context.subscriptions.push({ dispose: () => logger.dispose() });

    // Extension API (vscode.extensions.getExtension(...).exports): the live
    // index, so integration tests and sibling tooling can inspect it.
    return { index: scanner.index };
}

function deactivate() {
    formatterDisposable = null;
}

module.exports = { activate, deactivate };
