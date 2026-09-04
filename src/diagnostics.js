'use strict';

const { parseText } = require('./parser');
const { stripComment } = require('./formatter');

// ── Diagnostics ─────────────────────────────────────────────────────────────
// One "skript" DiagnosticCollection. A document is analysed on open, on
// change (debounced) and whenever the workspace index updates (for the
// cross-file `unknown-function` rule). Everything reads the live settings on
// each run, so toggling `skript.diagnostics.enabled` or a code in
// `skript.diagnostics.rules` takes effect on the next run.
//
// `analyze()` is pure text -> findings (no vscode dependency) so it can be
// unit-tested with plain node; `register()` wires it to the editor. The
// text is split into lines once and walked once; the per-file variable /
// option / call rules come from the same single-pass parser the index uses
// (src/parser.js), run on the current buffer so they never lag behind the
// debounced index.
//
// Every regex here is anchored and built from character classes: nothing
// backtracks over `.*`, so each rule is linear in the line length.

const SOURCE = 'skript';
const DEBOUNCE_MS = 400;
const INDEX_DEBOUNCE_MS = 200;
// Tabs count as 4 columns when comparing indentation depths. This is only
// for the comparison; nothing is rewritten with it.
const TAB_COLUMNS = 4;

const CODES = Object.freeze({
    DISABLED_FILE: 'disabled-file',
    MIXED_INDENT: 'mixed-indent',
    INDENT_AFTER_COLON: 'indent-after-colon',
    ELSE_INDENT_MISMATCH: 'else-indent-mismatch',
    WAIT_IN_INVENTORY_CLICK: 'wait-in-inventory-click',
    UNDEFINED_OPTION: 'undefined-option',
    LOCAL_NEVER_SET: 'local-never-set',
    UNKNOWN_FUNCTION: 'unknown-function',
});

// Functions that ship with Skript itself (never defined in a .sk file).
// Compared case-insensitively.
const BUILTIN_FUNCTIONS = new Set([
    'mod', 'abs', 'round', 'floor', 'ceil', 'ceiling', 'sqrt', 'min', 'max',
    'clamp', 'random', 'rgb', 'location', 'vector', 'world', 'date', 'exp',
    'ln', 'log', 'sin', 'cos', 'tan', 'atan2', 'product', 'sum', 'isnan',
    'numberofcharacters',
]);

const LEADING_WS_RE = /^[ \t]*/;
const TRAILING_WS_RE = /[ \t\f\v]+$/;
const OPTIONS_HEADER_RE = /^options\s*:/;
const FUNCTION_DEF_RE = /^(?:local\s+)?function\s+(\w+)\s*\(/;
const ELSE_RE = /^else\b/;
const IF_RE = /^(?:if|else\s+if)\b/;
// Section openers that are definitely not conditionals. Any other opener
// may be an implicit `if` (`player is op:`), so `else` is allowed to line
// up with it.
const NON_COND_RE = /^(?:loop|while|do|try|catch|on|command|function|every|at|options|trigger|aliases|variables|import|else|parse|section|effect|expression|condition|then|(?:else\s+)?(?:spawn|shoot|open|create|run))\b/;
const INVENTORY_CLICK_RE = /^on\s+inventory\s+click\b/;
const WAIT_RE = /^(?:wait|halt)\b/;
const CLOSE_INVENTORY_RE = /\bclose\b[^"#]*\binventory\b/;
const NEW_RE = /\bnew\s+$/;

// ── Pure helpers ────────────────────────────────────────────────────────────

function basenameOf(pathOrUri) {
    const s = String(pathOrUri);
    return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

function isDisabledName(basename) {
    return basename.startsWith('-');
}

// Visual column reached by a run of leading whitespace, with tab stops
// every TAB_COLUMNS columns.
function visualWidth(ws, tabSize) {
    const size = tabSize || TAB_COLUMNS;
    let col = 0;
    for (let i = 0; i < ws.length; i++) {
        col = ws[i] === '\t' ? (Math.floor(col / size) + 1) * size : col + 1;
    }
    return col;
}

function hasMixedIndent(ws) {
    return ws.indexOf('\t') !== -1 && ws.indexOf(' ') !== -1;
}

function quotesBalanced(code) {
    let n = 0;
    for (let i = 0; i < code.length; i++) if (code[i] === '"') n++;
    return n % 2 === 0;
}

// `_x::%uuid%::level` -> `_x`; `_x::*` -> `_x`
function localBase(name) {
    const sep = name.indexOf('::');
    return sep === -1 ? name : name.slice(0, sep);
}

function finding(code, severity, line, startChar, endChar, message) {
    return { code, severity, line, startChar, endChar, message };
}

// ── Analysis ────────────────────────────────────────────────────────────────
// options: {
//   basename:        file name (for `disabled-file`)
//   knownFunctions:  string[] from settings
//   workspaceFunctions: Map<name, { disabled, uri? }> from index.functions()
//                    (may be omitted: then only this file's own definitions
//                    count and `unknown-function` still runs)
//   isEnabled(code): per-rule toggle
// }
// Returns [{ code, severity: 'error'|'warning'|'information', line,
//            startChar, endChar, message, related? }].

function analyze(text, options) {
    const opts = options || {};
    const enabled = typeof opts.isEnabled === 'function' ? opts.isEnabled : () => true;
    const out = [];
    const lines = text.split(/\r?\n/);

    // ── file-level ──
    if (enabled(CODES.DISABLED_FILE) && opts.basename && isDisabledName(opts.basename)) {
        out.push(finding(CODES.DISABLED_FILE, 'information', 0, 0, lines[0].length,
            `Skript will not load this file: its name starts with "-" (disabled). Rename it to enable it.`));
    }

    // ── line pass ──
    // State carried between lines. Each is a small constant-size record so
    // the pass stays linear.
    const wantMixed = enabled(CODES.MIXED_INDENT);
    const wantColon = enabled(CODES.INDENT_AFTER_COLON);
    const wantElse = enabled(CODES.ELSE_INDENT_MISMATCH);
    const wantWait = enabled(CODES.WAIT_IN_INVENTORY_CLICK);

    let pendingOpener = null;        // last code line that ended in ':'
    let optionsWidth = -1;           // width of an open `options:` header, or -1
    const conds = [];                // stack of { width, line, label } candidate ifs
    let invClick = null;             // { width, closeSeen } while inside on inventory click
    const fnAtLine = new Array(lines.length);
    const optionLine = new Uint8Array(lines.length);   // 1 = an options: entry (template text)
    let currentFn = null;

    for (let li = 0; li < lines.length; li++) {
        const raw = lines[li];
        const ws = LEADING_WS_RE.exec(raw)[0];
        const content = raw.slice(ws.length).replace(TRAILING_WS_RE, '');
        fnAtLine[li] = currentFn;
        if (!content) continue;                       // blank
        if (content.charCodeAt(0) === 35 /* # */) continue; // comment-only line

        const width = visualWidth(ws);
        const code = stripComment(content).replace(TRAILING_WS_RE, '');
        if (!code) continue;

        // Function scope for `local-never-set`: definitions sit at column 0
        // and own every deeper line until the next column-0 code line.
        if (width === 0) {
            const def = FUNCTION_DEF_RE.exec(code);
            currentFn = def ? def[1] : null;
            fnAtLine[li] = currentFn;
        }

        // options: entries are raw text (`prefix: &7Boss:` is fine), never
        // section openers.
        if (optionsWidth !== -1 && width <= optionsWidth) optionsWidth = -1;
        const inOptions = optionsWidth !== -1;
        if (inOptions) optionLine[li] = 1;
        const opener = !inOptions && code.length > 1 && code.endsWith(':') && quotesBalanced(code);

        // mixed-indent
        if (wantMixed && hasMixedIndent(ws)) {
            out.push(finding(CODES.MIXED_INDENT, 'error', li, 0, ws.length,
                'Indentation mixes tabs and spaces. Skript treats that as an indentation error.'));
        }

        // indent-after-colon: the previous opener needs this line deeper.
        if (pendingOpener) {
            if (wantColon && width <= pendingOpener.width) {
                out.push(finding(CODES.INDENT_AFTER_COLON, 'error', pendingOpener.line, pendingOpener.startChar, pendingOpener.endChar,
                    `Line ends with ":" but the next line is not indented deeper (Skript: "Empty configuration section").`));
            }
            pendingOpener = null;
        }

        // else-indent-mismatch: line up with the nearest preceding
        // conditional at the same or a shallower depth.
        let popped = null;
        while (conds.length && conds[conds.length - 1].width > width) popped = conds.pop();
        if (ELSE_RE.test(code)) {
            // Nearest conditional at the same or a shallower depth. When
            // there is none but this very line closed a deeper one, the
            // else is sitting between its if and the parent: report that.
            const target = conds.length ? conds[conds.length - 1] : popped;
            if (wantElse && target && target.width !== width) {
                const f = finding(CODES.ELSE_INDENT_MISMATCH, 'error', li, ws.length, ws.length + (IF_RE.test(code) ? 7 : 4),
                    `"else" is indented to column ${width} but its "${target.label}" on line ${target.line + 1} is at column ${target.width}.`);
                f.related = { line: target.line, startChar: target.startChar, endChar: target.endChar, message: `"${target.label}" this else belongs to` };
                out.push(f);
            }
        }
        if (opener && (IF_RE.test(code) || !NON_COND_RE.test(code))) {
            while (conds.length && conds[conds.length - 1].width >= width) conds.pop();
            const label = IF_RE.test(code) ? (code.startsWith('else') ? 'else if' : 'if') : 'condition';
            conds.push({ width, line: li, startChar: ws.length, endChar: ws.length + code.length, label });
        }

        // wait-in-inventory-click
        if (invClick && width <= invClick.width) invClick = null;
        if (opener && INVENTORY_CLICK_RE.test(code)) {
            invClick = { width, closeSeen: false };
        } else if (invClick) {
            if (CLOSE_INVENTORY_RE.test(code)) invClick.closeSeen = true;
            else if (wantWait && WAIT_RE.test(code) && !invClick.closeSeen) {
                out.push(finding(CODES.WAIT_IN_INVENTORY_CLICK, 'warning', li, ws.length, ws.length + code.length,
                    `"wait" inside "on inventory click" without closing the inventory first. The event keeps the inventory open across the wait, which can dupe or lose items. Add "close player's inventory" above it.`));
            }
        }

        if (opener) {
            pendingOpener = { line: li, width, startChar: ws.length, endChar: ws.length + code.length };
            if (OPTIONS_HEADER_RE.test(code)) optionsWidth = width;
        }
    }
    if (pendingOpener && wantColon) {
        out.push(finding(CODES.INDENT_AFTER_COLON, 'error', pendingOpener.line, pendingOpener.startChar, pendingOpener.endChar,
            `Line ends with ":" but nothing follows it (Skript: "Empty configuration section").`));
    }

    // ── parsed-entry rules ──
    const wantOption = enabled(CODES.UNDEFINED_OPTION);
    const wantLocal = enabled(CODES.LOCAL_NEVER_SET);
    const wantFn = enabled(CODES.UNKNOWN_FUNCTION);
    if (!wantOption && !wantLocal && !wantFn) return out;

    const parsed = parseText(text);

    if (wantOption || wantLocal) {
        const optionNames = new Set(parsed.options.map(o => o.name));
        const localWrites = new Set();
        for (const v of parsed.variables) {
            if (v.kind === 'local' && v.write) localWrites.add(localBase(v.name));
        }
        const paramsByFn = new Map();
        for (const fn of parsed.functions) paramsByFn.set(fn.name, fn.params);

        for (const v of parsed.variables) {
            if (v.kind === 'option') {
                if (!wantOption) continue;
                const name = v.name.slice(1);
                if (optionNames.has(name)) continue;
                out.push(finding(CODES.UNDEFINED_OPTION, 'error', v.line, v.startChar, v.endChar,
                    `Option {@${name}} is not defined in this file's "options:" block.`));
            } else if (v.kind === 'local' && !v.write) {
                if (!wantLocal || optionLine[v.line]) continue;   // option values are templates
                const base = localBase(v.name);
                if (base.indexOf('%') !== -1) continue;        // dynamic name: can't tell
                if (localWrites.has(base)) continue;
                const fnName = fnAtLine[v.line];
                const params = fnName ? paramsByFn.get(fnName) : undefined;
                if (params && params.some(p => '_' + p.name === base)) continue;
                out.push(finding(CODES.LOCAL_NEVER_SET, 'warning', v.line, v.startChar, v.endChar,
                    `Local variable {${base}} is read but never set in this file. Locals do not survive between triggers or files.`));
            }
        }
    }

    if (wantFn) {
        const known = new Set(opts.knownFunctions || []);
        const localDefs = new Set(parsed.functions.map(f => f.name));
        const workspace = opts.workspaceFunctions || null;
        for (const call of parsed.calls) {
            const name = call.name;
            if (localDefs.has(name) || known.has(name) || BUILTIN_FUNCTIONS.has(name.toLowerCase())) continue;
            // skript-reflect: `obj.method(` and `new java.net.URL(` are not
            // Skript functions.
            const before = lines[call.line].slice(0, call.startChar);
            if (before.endsWith('.') || NEW_RE.test(before)) continue;
            const entry = workspace ? workspace.get(name) : undefined;
            if (entry && !entry.disabled) continue;
            const where = entry && entry.disabled
                ? `Function "${name}" is only defined in a disabled file (${basenameOf(entry.uri ? entry.uri.path : '')}), which Skript does not load.`
                : `Function "${name}" is not defined in any indexed .sk file. Add it to "skript.diagnostics.knownFunctions" if it comes from an addon.`;
            out.push(finding(CODES.UNKNOWN_FUNCTION, 'warning', call.line, call.startChar, call.endChar, where));
        }
    }

    return out;
}

// ── Quick fix helper (pure) ─────────────────────────────────────────────────
// Replacement leading whitespace for a mixed-indent line: the editor's
// indent unit repeated to the nearest visual depth of the original.

function repairIndent(ws, insertSpaces, tabSize) {
    const size = Math.max(1, tabSize || TAB_COLUMNS);
    const depth = Math.round(visualWidth(ws, size) / size);
    const unit = insertSpaces ? ' '.repeat(size) : '\t';
    return unit.repeat(depth);
}

// ── VS Code wiring ──────────────────────────────────────────────────────────
// `vscode` and the scanner are required lazily so the pure parts above load
// in plain node for the tests.

function register(context) {
    const vscode = require('vscode');
    const { index } = require('./scanner');
    const settings = require('./settings');

    const collection = vscode.languages.createDiagnosticCollection(SOURCE);
    context.subscriptions.push(collection);

    const SEVERITY = {
        error: vscode.DiagnosticSeverity.Error,
        warning: vscode.DiagnosticSeverity.Warning,
        information: vscode.DiagnosticSeverity.Information,
    };

    const timers = new Map();   // uriString -> timeout
    let indexTimer = null;

    const isSkript = doc => doc && doc.languageId === 'skript';

    function toDiagnostic(doc, f) {
        const range = new vscode.Range(f.line, f.startChar, f.line, f.endChar);
        const d = new vscode.Diagnostic(range, f.message, SEVERITY[f.severity]);
        d.code = f.code;
        d.source = SOURCE;
        if (f.related) {
            d.relatedInformation = [new vscode.DiagnosticRelatedInformation(
                new vscode.Location(doc.uri, new vscode.Range(f.related.line, f.related.startChar, f.related.line, f.related.endChar)),
                f.related.message
            )];
        }
        return d;
    }

    function lint(doc) {
        if (!isSkript(doc) || doc.isClosed) return;
        if (!settings.diagnosticsEnabled()) {
            collection.delete(doc.uri);
            return;
        }
        const findings = analyze(doc.getText(), {
            basename: basenameOf(doc.uri.path),
            knownFunctions: settings.knownFunctions(),
            workspaceFunctions: index.functions(),
            isEnabled: code => settings.diagnosticRuleEnabled(code),
        });
        collection.set(doc.uri, findings.map(f => toDiagnostic(doc, f)));
    }

    function schedule(doc) {
        if (!isSkript(doc)) return;
        const key = doc.uri.toString();
        const pending = timers.get(key);
        if (pending) clearTimeout(pending);
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            lint(doc);
        }, DEBOUNCE_MS));
    }

    function lintAllOpen() {
        for (const doc of vscode.workspace.textDocuments) lint(doc);
    }

    function clearAll() {
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        collection.clear();
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => lint(doc)),
        vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const pending = timers.get(key);
            if (pending) { clearTimeout(pending); timers.delete(key); }
            collection.delete(doc.uri);
        }),
        // Cross-file rule: a function defined or removed elsewhere changes
        // `unknown-function` here. Coalesce bursts of index updates.
        index.onDidUpdate(() => {
            if (indexTimer) clearTimeout(indexTimer);
            indexTimer = setTimeout(() => { indexTimer = null; lintAllOpen(); }, INDEX_DEBOUNCE_MS);
        }),
        settings.onDidChange(changed => {
            if (!changed.diagnostics) return;
            if (settings.diagnosticsEnabled()) lintAllOpen();
            else clearAll();
        }),
        { dispose: clearAll }
    );

    // ── Quick fix: mixed-indent ──
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider({ language: 'skript' }, {
            provideCodeActions(doc, _range, ctx) {
                const mixed = ctx.diagnostics.filter(d => d.source === SOURCE && d.code === CODES.MIXED_INDENT);
                if (!mixed.length) return undefined;

                const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
                const editorConfig = vscode.workspace.getConfiguration('editor', doc);
                const insertSpaces = editor && typeof editor.options.insertSpaces === 'boolean'
                    ? editor.options.insertSpaces
                    : editorConfig.get('insertSpaces', true);
                const tabSize = editor && typeof editor.options.tabSize === 'number'
                    ? editor.options.tabSize
                    : editorConfig.get('tabSize', 4);

                const fixFor = (lineNo) => {
                    const lineText = doc.lineAt(lineNo).text;
                    const ws = LEADING_WS_RE.exec(lineText)[0];
                    return vscode.TextEdit.replace(
                        new vscode.Range(lineNo, 0, lineNo, ws.length),
                        repairIndent(ws, insertSpaces, tabSize)
                    );
                };

                const actions = [];
                for (const d of mixed) {
                    const action = new vscode.CodeAction('Replace mixed indentation with the editor indent unit', vscode.CodeActionKind.QuickFix);
                    action.diagnostics = [d];
                    action.isPreferred = true;
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.set(doc.uri, [fixFor(d.range.start.line)]);
                    actions.push(action);
                }
                return actions;
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
    );

    lintAllOpen();
}

module.exports = {
    register,
    analyze,
    repairIndent,
    visualWidth,
    isDisabledName,
    CODES,
    BUILTIN_FUNCTIONS,
    SOURCE,
};
