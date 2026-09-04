'use strict';

const vscode = require('vscode');

// ── Settings ────────────────────────────────────────────────────────────────
// Typed getters for every `skript.*` setting. Each getter reads the live
// configuration, so callers always see the current value; nothing is cached
// here. `onDidChange` wraps onDidChangeConfiguration and tells the listener
// which group of settings moved.

const SECTION = 'skript';

const DEFAULTS = {
    'scan.glob': '**/*.sk',
    'scan.exclude': '**/node_modules/**',
    'scan.includeDisabledFiles': true,
    'diagnostics.enabled': true,
    'diagnostics.rules': {},
    'diagnostics.knownFunctions': [],
    'format.enabled': true,
    'completion.preselectVariables': false,
};

function read(key) {
    const value = vscode.workspace.getConfiguration(SECTION).get(key);
    return value === undefined || value === null ? DEFAULTS[key] : value;
}

function scanGlob() {
    const v = read('scan.glob');
    return typeof v === 'string' && v.trim() ? v : DEFAULTS['scan.glob'];
}

function scanExclude() {
    const v = read('scan.exclude');
    return typeof v === 'string' ? v : DEFAULTS['scan.exclude'];
}

function includeDisabledFiles() {
    return read('scan.includeDisabledFiles') !== false;
}

function diagnosticsEnabled() {
    return read('diagnostics.enabled') !== false;
}

function diagnosticsRules() {
    const v = read('diagnostics.rules');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// True unless the rule has been explicitly switched off.
function diagnosticRuleEnabled(code) {
    return diagnosticsRules()[code] !== false;
}

function knownFunctions() {
    const v = read('diagnostics.knownFunctions');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
}

function formatEnabled() {
    return read('format.enabled') !== false;
}

function preselectVariables() {
    return read('completion.preselectVariables') === true;
}

// Calls `listener({ scan, diagnostics, format, completion })` whenever any
// skript.* setting changes. Each flag says whether that group was affected.
function onDidChange(listener) {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration(SECTION)) return;
        listener({
            scan: e.affectsConfiguration(`${SECTION}.scan`),
            diagnostics: e.affectsConfiguration(`${SECTION}.diagnostics`),
            format: e.affectsConfiguration(`${SECTION}.format`),
            completion: e.affectsConfiguration(`${SECTION}.completion`),
        });
    });
}

module.exports = {
    DEFAULTS,
    scanGlob,
    scanExclude,
    includeDisabledFiles,
    diagnosticsEnabled,
    diagnosticsRules,
    diagnosticRuleEnabled,
    knownFunctions,
    formatEnabled,
    preselectVariables,
    onDidChange,
};
