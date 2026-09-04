'use strict';

const vscode = require('vscode');
const { parseText } = require('./parser');
const settings = require('./settings');
const { log } = require('./log');

// ── Workspace index ─────────────────────────────────────────────────────────
// One entry per `.sk` file, keyed by `uri.toString()`:
//
//   {
//     uri: vscode.Uri,
//     disabled: boolean,                 // basename starts with '-'
//     variables: [{ name, kind, line, startChar, endChar, write }],
//     options:   [{ name, line, startChar, endChar, value }],
//     functions: [{ name, line, startChar, endChar, params, returnType, docs }],
//     calls:     [{ name, line, startChar, endChar }],
//   }
//
// Derived views (`variables()`, `functions()`) are rebuilt lazily and cached
// until the next file update. Files are only ever re-read one at a time: the
// initial scan reads everything once with workspace.fs, after that a change
// to one document re-parses that document only.

const DEBOUNCE_MS = 500;
const MAX_FILES = 2000;
const READ_CONCURRENCY = 32;

const decoder = new TextDecoder('utf-8');

function isDisabledUri(uri) {
    const base = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    return base.startsWith('-');
}

class SkriptIndex {
    constructor() {
        this.files = new Map();
        this._emitter = new vscode.EventEmitter();
        this.onDidUpdate = this._emitter.event;
        this._variables = null;
        this._functions = null;
        this._timers = new Map();      // uriString -> { timer, getText }
        this._generation = 0;
        // Diagnostics counters: disk reads, parses, and full workspace scans.
        this.stats = { reads: 0, parses: 0, workspaceScans: 0 };
    }

    // ── mutation ──

    _invalidate() {
        this._variables = null;
        this._functions = null;
    }

    _store(uri, text) {
        const key = uri.toString();
        const disabled = isDisabledUri(uri);
        if (disabled && !settings.includeDisabledFiles()) {
            if (this.files.delete(key)) {
                this._invalidate();
                this._emitter.fire();
            }
            return;
        }
        const parsed = parseText(text);
        this.stats.parses++;
        this.files.set(key, {
            uri,
            disabled,
            variables: parsed.variables,
            options: parsed.options,
            functions: parsed.functions,
            calls: parsed.calls,
        });
        this._invalidate();
    }

    // Index one file. When `text` is omitted the file is read from disk.
    async scanFile(uri, text) {
        this._cancelTimer(uri);
        if (text === undefined) {
            try {
                this.stats.reads++;
                const bytes = await vscode.workspace.fs.readFile(uri);
                text = decoder.decode(bytes);
            } catch (_) {
                this.removeFile(uri);
                return;
            }
        }
        this._store(uri, text);
        this._emitter.fire();
    }

    removeFile(uri) {
        this._cancelTimer(uri);
        if (this.files.delete(uri.toString())) {
            this._invalidate();
            this._emitter.fire();
        }
    }

    // Debounced per-file rescan. `getText` (optional) is called when the timer
    // fires so the latest document text is used; without it the file is read
    // from disk.
    scheduleScan(uri, getText) {
        const key = uri.toString();
        const pending = this._timers.get(key);
        if (pending) clearTimeout(pending.timer);
        const timer = setTimeout(() => {
            this._timers.delete(key);
            const text = getText ? getText() : undefined;
            this.scanFile(uri, text).catch(err => log(`scan failed for ${uri.fsPath}: ${err && err.message}`));
        }, DEBOUNCE_MS);
        this._timers.set(key, { timer });
    }

    _cancelTimer(uri) {
        const key = uri.toString();
        const pending = this._timers.get(key);
        if (pending) {
            clearTimeout(pending.timer);
            this._timers.delete(key);
        }
    }

    // Full rescan. Reads every matching file with workspace.fs (never
    // openTextDocument), in small concurrent batches so the host stays
    // responsive. A newer scanWorkspace() call supersedes an older one.
    async scanWorkspace() {
        const generation = ++this._generation;
        this.stats.workspaceScans++;
        const glob = settings.scanGlob();
        const exclude = settings.scanExclude();
        const includeDisabled = settings.includeDisabledFiles();

        const label = `skript: workspace scan #${generation}`;
        console.time(label);
        const started = Date.now();

        let uris = [];
        try {
            uris = await vscode.workspace.findFiles(glob, exclude || undefined, MAX_FILES);
        } catch (err) {
            log(`findFiles failed: ${err && err.message}`);
        }
        if (generation !== this._generation) return;
        if (!includeDisabled) uris = uris.filter(u => !isDisabledUri(u));

        const entries = new Map();
        let index = 0;
        const worker = async () => {
            while (index < uris.length) {
                const uri = uris[index++];
                try {
                    this.stats.reads++;
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    entries.set(uri.toString(), { uri, text: decoder.decode(bytes) });
                } catch (_) {
                    // unreadable file: skip
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, uris.length || 1) }, worker));
        if (generation !== this._generation) return;

        this.files.clear();
        for (const { uri, text } of entries.values()) this._store(uri, text);
        this._invalidate();

        console.timeEnd(label);
        log(`workspace scan: ${this.files.size} file(s) indexed in ${Date.now() - started} ms (glob ${glob}; ${this.stats.reads} reads total)`);
        this._emitter.fire();
    }

    // ── derived views ──

    // Map<name, { kind, occurrences: [{ uri, line, startChar, endChar, write, disabled }] }>
    // Option definitions from `options:` blocks are included as `@name`
    // write occurrences so `{@` completion sees options that are never read.
    variables() {
        if (this._variables) return this._variables;
        const map = new Map();
        const add = (name, kind, occ) => {
            let entry = map.get(name);
            if (!entry) {
                entry = { kind, occurrences: [] };
                map.set(name, entry);
            }
            entry.occurrences.push(occ);
        };
        for (const file of this._sortedFiles()) {
            for (const v of file.variables) {
                add(v.name, v.kind, {
                    uri: file.uri, line: v.line, startChar: v.startChar, endChar: v.endChar,
                    write: v.write, disabled: file.disabled,
                });
            }
            for (const o of file.options) {
                add('@' + o.name, 'option', {
                    uri: file.uri, line: o.line, startChar: o.startChar, endChar: o.endChar,
                    write: true, disabled: file.disabled,
                });
            }
        }
        this._variables = map;
        return map;
    }

    // Map<name, FunctionEntry & { uri, disabled }>. The first definition in a
    // non-disabled file wins; a definition that only exists in a disabled file
    // is still returned, flagged `disabled: true`.
    functions() {
        if (this._functions) return this._functions;
        const map = new Map();
        for (const file of this._sortedFiles()) {
            for (const fn of file.functions) {
                const existing = map.get(fn.name);
                if (existing && !(existing.disabled && !file.disabled)) continue;
                map.set(fn.name, Object.assign({}, fn, { uri: file.uri, disabled: file.disabled }));
            }
        }
        this._functions = map;
        return map;
    }

    _sortedFiles() {
        return Array.from(this.files.values()).sort((a, b) => a.uri.toString() < b.uri.toString() ? -1 : 1);
    }

    dispose() {
        for (const { timer } of this._timers.values()) clearTimeout(timer);
        this._timers.clear();
        this.files.clear();
        this._invalidate();
        this._emitter.dispose();
    }
}

const index = new SkriptIndex();

// ── Wiring ──────────────────────────────────────────────────────────────────
// Initial scan plus document / file-system listeners. Everything is
// per-file after the initial scan.

function register(context) {
    context.subscriptions.push(index);

    index.scanWorkspace().catch(err => log(`initial scan failed: ${err && err.message}`));

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId !== 'skript') return;
            const doc = e.document;
            index.scheduleScan(doc.uri, () => doc.getText());
        })
    );

    // Untitled skript buffers are indexed while open; drop them on close.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc.languageId === 'skript' && doc.uri.scheme !== 'file') index.removeFile(doc.uri);
        })
    );

    let watcher = null;
    const createWatcher = () => {
        if (watcher) watcher.dispose();
        watcher = vscode.workspace.createFileSystemWatcher(settings.scanGlob());
        watcher.onDidCreate(uri => index.scheduleScan(uri));
        watcher.onDidChange(uri => index.scheduleScan(uri));
        watcher.onDidDelete(uri => index.removeFile(uri));
    };
    createWatcher();
    context.subscriptions.push({ dispose() { if (watcher) watcher.dispose(); } });

    context.subscriptions.push(
        settings.onDidChange(changed => {
            if (!changed.scan) return;
            createWatcher();
            index.scanWorkspace().catch(err => log(`rescan failed: ${err && err.message}`));
        })
    );
}

module.exports = { index, register, isDisabledUri };
