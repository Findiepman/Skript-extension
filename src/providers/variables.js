'use strict';

const vscode = require('vscode');
const { index } = require('../scanner');
const settings = require('../settings');

// ── Variable completion ─────────────────────────────────────────────────────
// Triggered on `{`. Reads from the workspace index; `{_` shows only locals,
// `{@` only options. The whole `{...}` word under the cursor is replaced so
// accepting an item never leaves a stray brace behind.

// Regex that treats {…} as a single word, passed explicitly to
// getWordRangeAtPosition so we never depend on cached language config.
const VAR_WORD = /\{[^}]*\}?|\w+/;

function kindToItemKind(kind) {
    switch (kind) {
        case 'option': return vscode.CompletionItemKind.Constant;
        case 'local': return vscode.CompletionItemKind.Variable;
        case 'list': return vscode.CompletionItemKind.Struct;
        default: return vscode.CompletionItemKind.Field;
    }
}

function fileLabel(uri) {
    return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function describe(info) {
    const files = new Map(); // uriString -> { label, disabled }
    for (const occ of info.occurrences) {
        const key = occ.uri.toString();
        if (!files.has(key)) files.set(key, { label: fileLabel(occ.uri), disabled: occ.disabled });
    }
    const names = Array.from(files.values())
        .map(f => f.disabled ? `${f.label} (disabled)` : f.label)
        .sort();
    const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, +${names.length - 8} more` : '');
    return `Found in ${files.size} file(s): ${shown}`;
}

function provideCompletionItems(document, position) {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    // Check if cursor is inside a { } variable reference.
    let braceIdx = -1;
    let depth = 0;
    for (let i = textBefore.length - 1; i >= 0; i--) {
        if (textBefore[i] === '}') depth++;
        if (textBefore[i] === '{') {
            if (depth === 0) { braceIdx = i; break; }
            depth--;
        }
    }
    if (braceIdx === -1) return undefined;

    const afterBrace = textBefore.substring(braceIdx + 1);
    const isLocal = afterBrace.startsWith('_');
    const isOption = afterBrace.startsWith('@');

    // Compute the exact range to replace — covers {typed} or {typed
    // including the opening brace and any auto-closed }.
    const replaceRange = document.getWordRangeAtPosition(position, VAR_WORD)
        || new vscode.Range(position, position);

    const items = [];
    let best = null; // { item, name } — closest prefix match, for preselect

    for (const [name, info] of index.variables()) {
        if (isOption && info.kind !== 'option') continue;
        if (isLocal && info.kind !== 'local') continue;

        const disabledOnly = info.occurrences.every(o => o.disabled);
        const fullVar = `{${name}}`;
        const item = new vscode.CompletionItem(fullVar, kindToItemKind(info.kind));
        item.detail = `${info.kind} variable${disabledOnly ? ' (disabled)' : ''}`;
        item.documentation = describe(info);
        item.insertText = fullVar;

        // Explicit range forces VS Code to replace the entire {typed}
        // word — both in insert (Tab) and replace (Enter) modes.
        item.range = replaceRange;

        const sep = name.indexOf('::');
        const baseName = sep === -1 ? name : name.slice(0, sep);
        item.filterText = `{${baseName}}`;

        // Disabled-only names sort last. List variables sort by their full
        // name, which starts with the `::` prefix, so {slayer::%uuid%::xp}
        // and {slayer::%uuid%::level} sit together.
        const bucket = disabledOnly ? '1' : '0';
        item.sortText = info.kind === 'list'
            ? `${bucket}a_${name}`
            : `${bucket}b_${name}`;

        if (afterBrace && name.startsWith(afterBrace) && !disabledOnly) {
            if (!best || name.length < best.name.length) best = { item, name };
        }

        items.push(item);
    }

    if (best && settings.preselectVariables()) best.item.preselect = true;

    return new vscode.CompletionList(items, true);
}

function register(context) {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'skript', scheme: 'file' },
            { provideCompletionItems },
            '{' // trigger character
        )
    );
}

module.exports = { register, provideCompletionItems };
