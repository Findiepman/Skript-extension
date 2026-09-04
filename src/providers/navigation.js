'use strict';

const vscode = require('vscode');
const { index } = require('../scanner');
const { findBraceSpans } = require('../parser');
const { functionWordAt, relativePath } = require('./functions');

// ── Navigation ──────────────────────────────────────────────────────────────
// Go-to-definition and find-references for functions, variables and
// options, plus hover for variables and options. Everything reads the live
// index on each call.
//
// There is deliberately NO rename provider: renaming a persistent global on
// a live server silently orphans stored data, so it stays out of scope.

// Fallback word pattern for a `{...` that is still being typed (no closing
// brace yet). Closed variables are resolved through the parser's brace
// spans instead, so nested forms like `{slayer::%{_uuid}%::level}` resolve
// to the outer variable when the cursor is on `slayer` and to `{_uuid}`
// when it is on the inner part — the same spans the index was built from.
const VAR_WORD_RE = /\{[^{}]*\}?/;
const MAX_HOVER_FILES = 15;

// ── Shared helpers ──

function toRange(occ) {
    return new vscode.Range(occ.line, occ.startChar, occ.line, occ.endChar);
}

function toLocation(uri, occ) {
    return new vscode.Location(uri, toRange(occ));
}

function disabledLast(a, b) {
    return (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0);
}

// `{name}` under the cursor -> { name, range } with the braces stripped, or
// null when the cursor is not on a variable.
function variableWordAt(document, position) {
    const lineText = document.lineAt(position.line).text;
    const ch = position.character;

    // Innermost balanced `{...}` containing the cursor (spans are ordered by
    // start, so the last one that still contains the cursor is innermost).
    let span = null;
    for (const s of findBraceSpans(lineText)) {
        if (s.start > ch) break;
        if (ch <= s.end) span = s;
    }
    if (span) {
        if (!span.name) return null;
        return { name: span.name, range: new vscode.Range(position.line, span.start, position.line, span.end) };
    }

    // Still being typed: `{slayer::` with no closing brace yet.
    const range = document.getWordRangeAtPosition(position, VAR_WORD_RE);
    if (!range) return null;
    let text = document.getText(range);
    if (!text.startsWith('{')) return null;
    text = text.slice(1);
    if (text.endsWith('}')) text = text.slice(0, -1);
    if (!text) return null;
    return { name: text, range };
}

function currentFile(document) {
    return index.files.get(document.uri.toString());
}

// Occurrences that count for `name` from `document`: locals stay in the
// current file, everything else is workspace-wide. Disabled files last.
function occurrencesFor(name, info, document) {
    let occs = info.occurrences;
    if (info.kind === 'local') {
        const key = document.uri.toString();
        occs = occs.filter(o => o.uri.toString() === key);
    }
    return occs.slice().sort(disabledLast);
}

// ── Functions ───────────────────────────────────────────────────────────────

// Every `function name(` line across the index, non-disabled files first.
function functionDefinitions(name) {
    const out = [];
    for (const file of index.files.values()) {
        for (const fn of file.functions) {
            if (fn.name === name) out.push({ uri: file.uri, disabled: file.disabled, entry: fn });
        }
    }
    return out.sort(disabledLast);
}

function functionCalls(name) {
    const out = [];
    for (const file of index.files.values()) {
        for (const call of file.calls) {
            if (call.name === name) out.push({ uri: file.uri, disabled: file.disabled, entry: call });
        }
    }
    return out.sort(disabledLast);
}

function provideFunctionDefinition(document, position) {
    const word = functionWordAt(document, position);
    if (!word) return undefined;
    const defs = functionDefinitions(word.name);
    if (!defs.length) return undefined;
    return defs.map(d => toLocation(d.uri, d.entry));
}

function provideFunctionReferences(document, position, context) {
    const word = functionWordAt(document, position);
    if (!word) return undefined;
    const refs = functionCalls(word.name).map(c => toLocation(c.uri, c.entry));
    if (context.includeDeclaration) {
        for (const d of functionDefinitions(word.name)) refs.push(toLocation(d.uri, d.entry));
    }
    return refs.length ? refs : undefined;
}

// ── Variables and options ───────────────────────────────────────────────────

// `{@opt}` definition: the `options:` entry of the same name in the SAME
// file. A missing entry returns nothing (diagnostics report it).
function optionDefinition(document, name) {
    const file = currentFile(document);
    if (!file) return undefined;
    const opt = file.options.find(o => o.name === name);
    return opt ? { file, opt } : undefined;
}

function provideVariableDefinition(document, position) {
    const word = variableWordAt(document, position);
    if (!word) return undefined;

    if (word.name.startsWith('@')) {
        const def = optionDefinition(document, word.name.slice(1));
        return def ? toLocation(def.file.uri, def.opt) : undefined;
    }

    const info = index.variables().get(word.name);
    if (!info) return undefined;
    const occs = occurrencesFor(word.name, info, document);
    if (!occs.length) return undefined;

    // First write in an enabled file, else the first occurrence anywhere.
    const write = occs.find(o => o.write && !o.disabled)
        || occs.find(o => o.write)
        || occs[0];
    return toLocation(write.uri, write);
}

function provideVariableReferences(document, position) {
    const word = variableWordAt(document, position);
    if (!word) return undefined;
    const info = index.variables().get(word.name);
    if (!info) return undefined;
    const occs = occurrencesFor(word.name, info, document);
    return occs.length ? occs.map(o => toLocation(o.uri, o)) : undefined;
}

function optionHover(document, word) {
    const def = optionDefinition(document, word.name.slice(1));
    if (!def) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**option** \`{${word.name}}\`\n\n`);
    md.appendCodeblock(`option ${def.opt.name} = ${def.opt.value}`, 'skript');
    return new vscode.Hover(md, word.range);
}

function variableHover(document, word) {
    const info = index.variables().get(word.name);
    if (!info) return undefined;
    const occs = occurrencesFor(word.name, info, document);
    if (!occs.length) return undefined;

    let reads = 0;
    let writes = 0;
    const files = new Map();   // uriString -> { label, disabled }
    for (const o of occs) {
        if (o.write) writes++;
        else reads++;
        const key = o.uri.toString();
        if (!files.has(key)) files.set(key, { label: relativePath(o.uri), disabled: o.disabled });
    }
    const labels = Array.from(files.values()).map(f => f.disabled ? `${f.label} (disabled)` : f.label);

    const lines = [
        `**${info.kind} variable** \`{${word.name}}\``,
        '',
        `${occs.length} occurrence${occs.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'} (${reads} read${reads === 1 ? '' : 's'}, ${writes} write${writes === 1 ? '' : 's'})`,
        '',
    ];
    for (const label of labels.slice(0, MAX_HOVER_FILES)) lines.push(`- ${label}`);
    if (labels.length > MAX_HOVER_FILES) lines.push(`- … and ${labels.length - MAX_HOVER_FILES} more`);

    return new vscode.Hover(new vscode.MarkdownString(lines.join('\n')), word.range);
}

function provideVariableHover(document, position) {
    const word = variableWordAt(document, position);
    if (!word) return undefined;
    return word.name.startsWith('@') ? optionHover(document, word) : variableHover(document, word);
}

// ── Registration ────────────────────────────────────────────────────────────

const SELECTOR = { language: 'skript', scheme: 'file' };

function register(context) {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition: provideFunctionDefinition }),
        vscode.languages.registerReferenceProvider(SELECTOR, { provideReferences: provideFunctionReferences }),
        vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition: provideVariableDefinition }),
        vscode.languages.registerReferenceProvider(SELECTOR, { provideReferences: provideVariableReferences }),
        vscode.languages.registerHoverProvider(SELECTOR, { provideHover: provideVariableHover })
    );
}

module.exports = {
    register,
    provideFunctionDefinition,
    provideFunctionReferences,
    provideVariableDefinition,
    provideVariableReferences,
    provideVariableHover,
    variableWordAt,
    VAR_WORD_RE,
};
