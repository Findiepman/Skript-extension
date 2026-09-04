'use strict';

const vscode = require('vscode');
const { index } = require('../scanner');

// ── Function IntelliSense ───────────────────────────────────────────────────
// Completion, hover and signature help for user-defined functions. Every
// provider reads `index.functions()` on each call and never caches a copy,
// so a definition edited in another file shows up as soon as the scanner
// has re-indexed it.
//
// All per-keystroke helpers here are single forward passes over one line:
// no regex backtracking, no document re-reads.

const IDENT_RE = /[A-Za-z_]\w*/;
const FUNCTION_DEF_RE = /^\s*(?:local\s+)?function\s+(\w+)\(/;

// ── Pure helpers (exported for tests) ──

// Where the cursor sits on a line: inside a `{...}` variable, or inside a
// "..." string. `%...%` expressions inside strings count as code, matching
// the parser's string mask.
function cursorContext(lineText, character) {
    let str = false;
    let expr = false;
    let depth = 0;
    const end = Math.min(character, lineText.length);
    for (let i = 0; i < end; i++) {
        const c = lineText[i];
        if (c === '"') {
            str = !str;
            expr = false;
            continue;
        }
        if (str && c === '%') {
            expr = !expr;
            continue;
        }
        if (str && !expr) continue;
        if (c === '{') depth++;
        else if (c === '}' && depth > 0) depth--;
    }
    return { inBraces: depth > 0, inString: str && !expr };
}

// The innermost unclosed `name(` call to the left of `character`, and the
// index of the argument the cursor is in. Commas inside "...", {...} and
// nested (...) do not count. Returns null when the cursor is not inside a
// call.
function callContext(lineText, character) {
    const stack = [];   // { name, commas, braces }
    let str = false;
    let expr = false;
    const end = Math.min(character, lineText.length);
    for (let i = 0; i < end; i++) {
        const c = lineText[i];
        if (c === '"') {
            str = !str;
            expr = false;
            continue;
        }
        if (str && c === '%') {
            expr = !expr;
            continue;
        }
        if (str && !expr) continue;
        const top = stack.length ? stack[stack.length - 1] : null;
        if (c === '(') {
            let s = i;
            while (s > 0 && /\w/.test(lineText[s - 1])) s--;
            stack.push({ name: lineText.slice(s, i), commas: 0, braces: 0 });
        } else if (c === ')') {
            if (top) stack.pop();
        } else if (c === '{') {
            if (top) top.braces++;
        } else if (c === '}') {
            if (top && top.braces > 0) top.braces--;
        } else if (c === ',') {
            if (top && top.braces === 0) top.commas++;
        }
    }
    // Skip anonymous groups like `(a, b)` and find the nearest named call.
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name) return { name: stack[i].name, activeParameter: stack[i].commas };
    }
    return null;
}

function paramLabel(p) {
    let s = p.name;
    if (p.type) s += `: ${p.type}`;
    if (p.defaultValue !== undefined) s += ` = ${p.defaultValue}`;
    return s;
}

// `function name(p: player, q: text) :: boolean`, plus the [start, end]
// offsets of each parameter inside that label (for signature help).
function signatureLabel(fn) {
    let label = `function ${fn.name}(`;
    const offsets = [];
    fn.params.forEach((p, i) => {
        if (i > 0) label += ', ';
        const start = label.length;
        label += paramLabel(p);
        offsets.push([start, label.length]);
    });
    label += ')';
    if (fn.returnType) label += ` :: ${fn.returnType}`;
    return { label, offsets };
}

function snippetEscape(s) {
    return s.replace(/[\\$}]/g, '\\$&');
}

// `name(${1:p}, ${2:q})` — empty parens when there are no parameters.
function insertSnippet(fn) {
    const parts = fn.params.map((p, i) => `\${${i + 1}:${snippetEscape(p.name)}}`);
    return `${fn.name}(${parts.join(', ')})`;
}

function mdEscape(s) {
    return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Markdown shared by completion documentation and hover.
//   deprecated, description, parameter table, returns, example, [defined-in]
function docsMarkdown(fn, definedIn) {
    const docs = fn.docs || {};
    const out = [];
    if (docs.deprecated) out.push(`**Deprecated:** ${docs.deprecated}`);
    if (docs.description) out.push(docs.description);
    if (fn.params.length) {
        const rows = ['| Parameter | Description |', '| --- | --- |'];
        for (const p of fn.params) {
            let cell = p.name;
            if (p.type) cell += `: ${p.type}`;
            if (p.defaultValue !== undefined) cell += ` (default: ${p.defaultValue})`;
            const text = docs.params && docs.params[p.name] ? docs.params[p.name] : '';
            rows.push(`| \`${mdEscape(cell)}\` | ${mdEscape(text)} |`);
        }
        out.push(rows.join('\n'));
    }
    if (fn.returnType || docs.returns) {
        let line = '**Returns**';
        if (fn.returnType) line += ` \`${fn.returnType}\``;
        if (docs.returns) line += ` — ${docs.returns}`;
        out.push(line);
    }
    if (docs.example) out.push('**Example**\n```skript\n' + docs.example + '\n```');
    if (definedIn) out.push(`Defined in ${definedIn}`);
    return out.join('\n\n');
}

// Word under the cursor plus whether it is a call site (identifier followed
// by an opening paren) or the name on a `function name(` definition line.
// Shared with the navigation providers so every feature agrees on what a
// "function name" is. Returns null for anything else (plain words, strings).
function functionWordAt(document, position) {
    const range = document.getWordRangeAtPosition(position, IDENT_RE);
    if (!range) return null;
    const lineText = document.lineAt(position.line).text;
    const name = lineText.slice(range.start.character, range.end.character);

    const def = FUNCTION_DEF_RE.exec(lineText);
    if (def && def[1] === name && lineText.indexOf(name + '(') === range.start.character) {
        return { name, range, isDefinition: true, isCall: false };
    }

    const ctx = cursorContext(lineText, range.start.character);
    if (ctx.inString) return null;
    let i = range.end.character;
    while (i < lineText.length && (lineText[i] === ' ' || lineText[i] === '\t')) i++;
    if (lineText[i] !== '(') return null;
    return { name, range, isDefinition: false, isCall: true };
}

function relativePath(uri) {
    return vscode.workspace.asRelativePath(uri, false);
}

function buildMarkdown(fn, withLocation) {
    const definedIn = withLocation ? `${relativePath(fn.uri)}:${fn.line + 1}` : undefined;
    return new vscode.MarkdownString(docsMarkdown(fn, definedIn));
}

// ── Completion ──────────────────────────────────────────────────────────────
// Word-triggered (no trigger characters). Skipped inside `{...}` (the
// variable provider owns that) and inside strings.

function provideCompletionItems(document, position) {
    const lineText = document.lineAt(position.line).text;
    const ctx = cursorContext(lineText, position.character);
    if (ctx.inBraces || ctx.inString) return undefined;

    const replaceRange = document.getWordRangeAtPosition(position, IDENT_RE);
    const items = [];
    for (const [name, fn] of index.functions()) {
        const { label } = signatureLabel(fn);
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = fn.disabled ? `${label} (disabled file)` : label;
        item.documentation = buildMarkdown(fn, false);
        item.insertText = new vscode.SnippetString(insertSnippet(fn));
        if (replaceRange) item.range = replaceRange;
        item.sortText = `${fn.disabled ? '1' : '0'}_${name}`;
        if (fn.docs && fn.docs.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
        items.push(item);
    }
    return items.length ? items : undefined;
}

// ── Hover ───────────────────────────────────────────────────────────────────

function provideHover(document, position) {
    const word = functionWordAt(document, position);
    if (!word) return undefined;
    const fn = index.functions().get(word.name);
    if (!fn) return undefined;
    // Signature first, so the hover names the function even without docs.
    const md = new vscode.MarkdownString();
    md.appendCodeblock(signatureLabel(fn).label, 'skript');
    md.appendMarkdown('\n' + buildMarkdown(fn, true).value);
    return new vscode.Hover(md, word.range);
}

// ── Signature help ──────────────────────────────────────────────────────────

function provideSignatureHelp(document, position) {
    const lineText = document.lineAt(position.line).text;
    const call = callContext(lineText, position.character);
    if (!call) return undefined;
    const fn = index.functions().get(call.name);
    if (!fn) return undefined;

    const { label, offsets } = signatureLabel(fn);
    const sig = new vscode.SignatureInformation(label, buildMarkdown(fn, true));
    const docs = fn.docs || {};
    sig.parameters = fn.params.map((p, i) => {
        const text = docs.params && docs.params[p.name] ? docs.params[p.name] : undefined;
        return new vscode.ParameterInformation(offsets[i], text ? new vscode.MarkdownString(text) : undefined);
    });

    const help = new vscode.SignatureHelp();
    help.signatures = [sig];
    help.activeSignature = 0;
    help.activeParameter = fn.params.length
        ? Math.min(call.activeParameter, fn.params.length - 1)
        : 0;
    return help;
}

// ── Registration ────────────────────────────────────────────────────────────

const SELECTOR = { language: 'skript', scheme: 'file' };

function register(context) {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems }),
        vscode.languages.registerHoverProvider(SELECTOR, { provideHover }),
        vscode.languages.registerSignatureHelpProvider(SELECTOR, { provideSignatureHelp }, {
            triggerCharacters: ['(', ','],
            retriggerCharacters: [','],
        })
    );
}

module.exports = {
    register,
    provideCompletionItems,
    provideHover,
    provideSignatureHelp,
    // shared helpers
    functionWordAt,
    cursorContext,
    callContext,
    signatureLabel,
    insertSnippet,
    docsMarkdown,
    relativePath,
    IDENT_RE,
};
