'use strict';

// ── Skript file parser ──────────────────────────────────────────────────────
// Pure text -> index entries. No vscode dependency so it can be unit-tested
// with plain node. The scanner (src/scanner.js) wraps this per file.
//
// parseText(text) returns:
//   {
//     variables: [{ name, kind, line, startChar, endChar, write }],
//     options:   [{ name, line, startChar, endChar, value }],
//     functions: [{ name, line, startChar, endChar, params, returnType, docs }],
//     calls:     [{ name, line, startChar, endChar }],
//   }
// Positions are 0-based line / character offsets. startChar/endChar of a
// variable span the whole `{...}`; for options, functions and calls they span
// the bare name.
//
// Every regex here runs on a single line and is linear in the line length:
// character classes only, no nested quantifiers over `.*`.

const { stripComment } = require('./formatter');

const PLACEHOLDER_ONLY_RE = /^%[^%]+%$/;
const OPTIONS_HEADER_RE = /^options\s*:/;
// Option names may contain spaces (`only victim: ...`), so the name runs up
// to the first `:` / `=`; trailing spaces are trimmed off afterwards.
const OPTION_ENTRY_RE = /^(\s+)([\w][\w -]*?)\s*[:=]\s*(.*)$/;
const FUNCTION_RE = /^(?:local\s+)?function\s+(\w+)\(([^)]*)\)(?:\s*::\s*([^:]+?))?\s*:/;
const CALL_RE = /\b([A-Za-z_]\w*)\(/g;
const DOC_TAG_RE = /^#(ddep|dex|dp|dr|d)\b\s*(.*)$/;
const PLAIN_COMMENT_RE = /^#\s?(.*)$/;

// Write detection on the text before the opening brace:
//   set {x} to ...   delete {x}   clear {x}   reset {x}
//   add ... to {x}   remove ... from {x}   remove all ... from {x}
//   ... and store it in {x}   (DiSky, skript-db "store the result in")
//   saveInto: {x}             (DiSky embed / message sections)
const WRITE_DIRECT_RE = /^\s*(?:set|delete|clear|reset)\s+$/i;
const WRITE_TARGET_RE = /^\s*(?:add|remove(?:\s+all)?)\s[^\n]*\s(?:to|from)\s+$/i;
const WRITE_STORE_RE = /(?:\bstore\s+(?:it|them|the\s+results?)\s+in|\bsaveInto\s*:)\s+$/i;

function classifyVariable(raw) {
    if (raw.startsWith('@')) return 'option';
    if (raw.startsWith('_')) return 'local';
    if (raw.includes('::')) return 'list';
    return 'global';
}

function isWrite(prefix) {
    return WRITE_DIRECT_RE.test(prefix) || WRITE_TARGET_RE.test(prefix) || WRITE_STORE_RE.test(prefix);
}

// For each character index of `line`, whether it sits inside a "..." string
// and whether it sits inside a %...% expression within that string. Computed
// once per line and shared by the variable and call passes.
function stringMask(line) {
    const inString = new Uint8Array(line.length);
    const inExpr = new Uint8Array(line.length);
    let str = false;
    let expr = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            str = !str;
            expr = false;
        } else if (c === '%' && str) {
            expr = !expr;
        }
        inString[i] = str ? 1 : 0;
        inExpr[i] = expr ? 1 : 0;
    }
    return { inString, inExpr };
}

// Every balanced `{...}` span on a line, nested ones included, ordered by
// start offset. `{slayer::%{_uuid}%::level}` yields both the outer variable
// and the inner `{_uuid}`. One linear pass with a stack of open braces; an
// unmatched `{` or `}` is simply ignored.
function findBraceSpans(line) {
    const spans = [];
    const open = [];
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '{') {
            open.push(i);
        } else if (c === '}' && open.length) {
            const start = open.pop();
            spans.push({ start, end: i + 1, name: line.slice(start + 1, i) });
        }
    }
    return spans.sort((a, b) => a.start - b.start);
}

function splitParams(raw) {
    const parts = [];
    let depth = 0;
    let str = false;
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') str = !str;
        if (!str) {
            if (c === '(' || c === '{' || c === '[') depth++;
            else if (c === ')' || c === '}' || c === ']') depth--;
            else if (c === ',' && depth === 0) {
                parts.push(cur);
                cur = '';
                continue;
            }
        }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

function parseParams(raw) {
    const params = [];
    for (const part of splitParams(raw)) {
        const p = part.trim();
        if (!p) continue;
        const colon = p.indexOf(':');
        if (colon === -1) {
            params.push({ name: p, type: undefined, defaultValue: undefined });
            continue;
        }
        const name = p.slice(0, colon).trim();
        let rest = p.slice(colon + 1);
        let defaultValue;
        // First `=` outside a string starts the default value.
        let str = false;
        for (let i = 0; i < rest.length; i++) {
            const c = rest[i];
            if (c === '"') str = !str;
            else if (c === '=' && !str) {
                defaultValue = rest.slice(i + 1).trim();
                rest = rest.slice(0, i);
                break;
            }
        }
        params.push({ name, type: rest.trim() || undefined, defaultValue });
    }
    return params;
}

// Collects the contiguous run of `#` comment lines directly above `lineIdx`.
function parseDocs(lines, lineIdx) {
    const block = [];
    for (let i = lineIdx - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t.startsWith('#')) break;
        block.unshift(t);
    }
    if (!block.length) return {};

    const docs = {};
    const description = [];
    for (const raw of block) {
        const tag = DOC_TAG_RE.exec(raw);
        if (tag) {
            const text = tag[2].trim();
            switch (tag[1]) {
                case 'd':
                    description.push(text);
                    break;
                case 'dp': {
                    const sp = text.search(/\s/);
                    const pname = sp === -1 ? text : text.slice(0, sp);
                    const ptext = sp === -1 ? '' : text.slice(sp + 1).trim();
                    if (pname) {
                        if (!docs.params) docs.params = {};
                        docs.params[pname] = ptext;
                    }
                    break;
                }
                case 'dr':
                    docs.returns = text;
                    break;
                case 'dex':
                    docs.example = docs.example ? `${docs.example}\n${text}` : text;
                    break;
                case 'ddep':
                    docs.deprecated = text || 'Deprecated';
                    break;
            }
            continue;
        }
        const plain = PLAIN_COMMENT_RE.exec(raw);
        if (plain && plain[1].trim()) description.push(plain[1].trim());
    }
    if (description.length) docs.description = description.join('\n');
    return docs;
}

function parseText(text) {
    const variables = [];
    const options = [];
    const functions = [];
    const calls = [];

    const lines = text.split('\n');
    let inOptions = false;

    for (let li = 0; li < lines.length; li++) {
        let line = lines[li];
        if (line.endsWith('\r')) line = line.slice(0, -1);

        // ── options: block ──
        if (OPTIONS_HEADER_RE.test(line)) {
            inOptions = true;
            continue;
        }
        if (inOptions) {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !line.startsWith('\t') && !line.startsWith(' ')) {
                inOptions = false;
            } else {
                const m = OPTION_ENTRY_RE.exec(stripComment(line));
                if (m) {
                    const startChar = m[1].length;
                    options.push({
                        name: m[2],
                        line: li,
                        startChar,
                        endChar: startChar + m[2].length,
                        value: m[3].trim(),
                    });
                }
                // Option values may reference other things; fall through so
                // `{@x}` inside a value is still indexed as a read.
            }
        }

        const code = stripComment(line);
        if (!code.trim()) continue;

        // ── function definition ──
        const fn = FUNCTION_RE.exec(code);
        let fnStart = -1;
        if (fn) {
            fnStart = code.indexOf(fn[1] + '(', code.indexOf('function') + 8);
            functions.push({
                name: fn[1],
                line: li,
                startChar: fnStart,
                endChar: fnStart + fn[1].length,
                params: parseParams(fn[2]),
                returnType: fn[3] ? fn[3].trim() : undefined,
                docs: parseDocs(lines, li),
            });
        }

        const mask = stringMask(code);

        // ── variables ──
        for (const span of findBraceSpans(code)) {
            const name = span.name;
            if (!name || PLACEHOLDER_ONLY_RE.test(name)) continue;
            if (mask.inString[span.start]) {
                const looksLikeVar = name.startsWith('_') || name.startsWith('@') || name.includes('::');
                if (!looksLikeVar) continue;
            }
            variables.push({
                name,
                kind: classifyVariable(name),
                line: li,
                startChar: span.start,
                endChar: span.end,
                write: !mask.inString[span.start] && isWrite(code.slice(0, span.start)),
            });
        }

        // ── function calls ──
        CALL_RE.lastIndex = 0;
        let m;
        while ((m = CALL_RE.exec(code)) !== null) {
            if (m.index === fnStart) continue; // the definition itself
            if (mask.inString[m.index] && !mask.inExpr[m.index]) continue;
            calls.push({
                name: m[1],
                line: li,
                startChar: m.index,
                endChar: m.index + m[1].length,
            });
        }
    }

    return { variables, options, functions, calls };
}

module.exports = { parseText, classifyVariable, isWrite, parseParams, parseDocs, findBraceSpans };
