'use strict';

// Skript reindenter.
//
// Skript has no closing braces: a line ending in ":" (outside strings and
// comments) opens a section, and the section contains every following line
// that is indented deeper than it. Skript itself is strict about this and
// rejects three things at load time:
//
//   1. a line indented deeper than the previous line when that previous line
//      did not open a section          -> "indentation error"
//   2. a line that opens a section but is followed by a line at the same
//      indentation                      -> "Empty configuration section!"
//   3. a dedent to an indentation width that no enclosing section uses
//                                       -> "indentation error"
//
// This formatter fixes exactly those, plus two structural mistakes Skript
// would also reject ("else" not lined up with its "if", and an event /
// command / function header that is not at column 0), and it normalizes the
// indent unit (tabs vs. spaces). Code that Skript would already accept is
// only ever touched for unit normalization and trailing whitespace; its
// nesting is preserved as written, because in Skript the nesting IS the
// indentation and there is nothing else to derive it from.
//
// Fixing an error means snapping the offending line to where it belongs and
// then carrying that same correction through every following line that is
// still indented at or beyond the offending line's original width (a
// "region"). That is what makes a pasted block land correctly as a whole:
// a chunk pasted at the wrong depth keeps its own internal nesting and is
// shifted as one unit, until the source dedents back out of the chunk.

const TOP_LEVEL_RE = /^(on |command \/|function [A-Za-z_]\w*\s*\(|every |options\s*:|variables\s*:|aliases\s*:|import\s*:)/;
const ELSE_RE = /^else\b/;
// Sections that are definitely NOT conditionals. Any other section opener
// may be one: Skript treats a bare line such as `player has permission "x":`
// as an implicit "if", so the only safe test is exclusion.
const NON_COND_RE = /^(loop\b|while\b|do\b|try\b|catch\b|trigger\s*:|on\b|command\b|function\b|every\b|at\b|options\s*:|variables\s*:|aliases\s*:|import\s*:|define\b|discord\b|effect\b|expression\b|condition\b|section\b|local\b|plural\b|get\s*:|set\s*:|add\s*:|remove\s*:|delete\s*:|reset\s*:|parse\s*:|check\s*:|return\s*:|pattern\s*:|patterns\s*:|usable in\s*:|event-values\s*:|then\s*:|(else\s+)?(spawn|shoot|open|create|run)\b)/;

// Returns the part of `line` before any comment, honoring "..." strings
// ("" is an escaped quote inside a string) and ## as an escaped hash.
// Single quotes are NOT string delimiters in Skript ({_p}'s uuid).
function stripComment(line) {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inString = !inString;
        } else if (c === '#' && !inString) {
            if (line[i + 1] === '#') { i++; continue; }
            return line.slice(0, i);
        }
    }
    return line;
}

function indentWidth(ws, tabSize) {
    let w = 0;
    for (const ch of ws) w += ch === '\t' ? tabSize : 1;
    return w;
}

function classifyLines(lines, tabSize) {
    return lines.map((raw) => {
        const line = raw.replace(/[ \t\f\v ]+$/, '');
        if (line.trim().length === 0) return { kind: 'blank' };

        const leading = /^[ \t]*/.exec(line)[0];
        const content = line.slice(leading.length);
        const width = indentWidth(leading, tabSize);

        if (content.startsWith('#')) {
            return { kind: 'comment', width, content };
        }

        const code = stripComment(content).replace(/[ \t]+$/, '');
        // An unterminated string is already broken; never let it open a
        // section and drag its neighbours in.
        const balancedQuotes = (code.match(/"/g) || []).length % 2 === 0;
        const opener = code.length > 1 && code.endsWith(':') && balancedQuotes;
        return {
            kind: 'code',
            width,
            content,
            opener,
            isElse: ELSE_RE.test(code),
            isCond: opener && !NON_COND_RE.test(code),
            isTopLevel: opener && TOP_LEVEL_RE.test(code),
        };
    });
}

function nearestFrame(lower, upper, vw) {
    if (!upper) return lower;
    const dLower = vw - lower.width;
    const dUpper = upper.width - vw;
    // Tie goes to the deeper frame: staying inside the current section is
    // the smaller structural change.
    return dUpper <= dLower ? upper : lower;
}

// Computes the output indentation level for every code line.
function computeLevels(infos, tabSize) {
    // frames: every indentation width currently valid to dedent back to.
    // Each frame is the indentation of the CHILDREN of an open section.
    const frames = [{ width: 0, level: 0, shiftDepth: 0 }];
    // shifts: active region corrections. A region starts at an original
    // width and applies `delta` to every line at or beyond that width.
    const shifts = [];
    // The last line emitted at each level, used to line up "else".
    const lastAtLevel = new Map();
    // Virtual root "previous line": column 0, not an opener.
    let prev = { vw: 0, level: 0, opener: false };

    const shiftTotal = () => shifts.reduce((s, x) => s + x.delta, 0);
    const popFramesDeeperThan = (level) => {
        while (frames.length > 1 && frames[frames.length - 1].level > level) frames.pop();
    };
    const popRegionFrames = () => {
        while (frames.length > 1 && frames[frames.length - 1].shiftDepth > shifts.length) frames.pop();
    };

    for (const info of infos) {
        if (info.kind !== 'code') continue;
        const w = info.width;

        // Leave any region this line has dedented out of. Once a region is
        // left, `prev` (which sat inside it) is no longer comparable: this
        // line is, by construction, shallower than every line of the region
        // in original columns, so it is a dedent relative to `prev`.
        let leftRegion = false;
        while (shifts.length && w < shifts[shifts.length - 1].start) {
            shifts.pop();
            popRegionFrames();
            leftRegion = true;
        }
        let vw = w + shiftTotal();
        if (leftRegion) prev = { vw: Infinity, level: prev.level, opener: false };
        let level;
        // Pending snap: shift this line (and its region) from vw to target.
        let target = null;
        // Frame to push for this line's children-of-opener, if any.
        let pushFrame = null;

        if (prev.opener) {
            if (vw > prev.vw) {
                level = prev.level + 1;
                pushFrame = { width: vw, level };
            } else if (vw === prev.vw) {
                // Empty section: pull this line (and its region) into it.
                level = prev.level + 1;
                target = prev.vw + tabSize;
                pushFrame = { width: target, level };
            } else {
                level = dedent(vw);
            }
        } else if (vw > prev.vw) {
            // Deeper than a line that opened nothing: sibling of it.
            level = prev.level;
            target = prev.vw;
        } else if (vw === prev.vw) {
            level = prev.level;
        } else {
            level = dedent(vw);
        }

        function dedent(width) {
            let upper = null;
            while (frames.length > 1 && frames[frames.length - 1].width > width) {
                upper = frames.pop();
            }
            const lower = frames[frames.length - 1];
            if (lower.width === width) return lower.level;
            const pick = nearestFrame(lower, upper, width);
            if (pick === upper) frames.push(upper);
            target = pick.width;
            return pick.level;
        }

        // Event / command / function headers always live at column 0.
        if (info.isTopLevel && level > 0) {
            level = 0;
            target = 0;
            pushFrame = null;
            popFramesDeeperThan(0);
        }

        // "else" indented as if it were inside the body of its own "if":
        // move it up one level to line up with that "if". Only when the
        // line before it at its own level is a plain statement (not any
        // section opener) and the enclosing section can be a conditional.
        if (info.isElse && level > 0) {
            const sibling = lastAtLevel.get(level);
            const parent = lastAtLevel.get(level - 1);
            if (!(sibling && sibling.opener) && parent && parent.isCond) {
                level -= 1;
                pushFrame = null;
                popFramesDeeperThan(level);
                target = frames[frames.length - 1].width;
            }
        }

        if (target !== null && target !== vw) {
            shifts.push({ start: w, delta: target - vw });
            vw = target;
        }
        if (pushFrame) {
            pushFrame.shiftDepth = shifts.length;
            frames.push(pushFrame);
        }
        if (target !== null && !pushFrame) {
            popFramesDeeperThan(level);
        }

        info.level = level;
        for (const key of [...lastAtLevel.keys()]) if (key > level) lastAtLevel.delete(key);
        lastAtLevel.set(level, info);
        prev = { vw, level, opener: info.opener };
    }
}

// Comment-only lines carry no structure in Skript. Give each one the level
// of whichever neighboring code line it was visually closest to, so a
// comment written above a statement stays with that statement and a
// trailing comment at the end of a block stays inside the block.
function placeComments(infos) {
    let prev = null;
    for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        if (info.kind === 'code') { prev = info; continue; }
        if (info.kind !== 'comment') continue;

        let next = null;
        for (let j = i + 1; j < infos.length; j++) {
            if (infos[j].kind === 'code') { next = infos[j]; break; }
        }

        if (prev && prev.opener && info.width > prev.width) {
            info.level = prev.level + 1;
        } else if (prev && next) {
            const dPrev = Math.abs(info.width - prev.width);
            const dNext = Math.abs(info.width - next.width);
            info.level = dNext <= dPrev ? next.level : prev.level;
        } else if (next) {
            info.level = next.level;
        } else if (prev) {
            info.level = prev.level;
        } else {
            info.level = 0;
        }
    }
}

/**
 * Reindents Skript source.
 * @param {string} text
 * @param {{insertSpaces?: boolean, tabSize?: number, eol?: string}} [options]
 * @returns {string}
 */
function formatSkript(text, options) {
    const opts = options || {};
    const tabSize = Math.max(1, opts.tabSize || 4);
    const unit = opts.insertSpaces ? ' '.repeat(tabSize) : '\t';
    const eol = opts.eol || (text.includes('\r\n') ? '\r\n' : '\n');

    const lines = text.split(/\r\n|\r|\n/);
    const infos = classifyLines(lines, tabSize);
    computeLevels(infos, tabSize);
    placeComments(infos);

    return infos
        .map((info) => (info.kind === 'blank' ? '' : unit.repeat(info.level) + info.content))
        .join(eol);
}

// ── VS Code provider ────────────────────────────────────────────────────────
// `vscode` is required lazily so this module can still be loaded by the node
// unit tests, which run outside the extension host.

function createIndentFormatter() {
    const vscode = require('vscode');
    return vscode.languages.registerDocumentFormattingEditProvider(
        { language: 'skript', scheme: 'file' },
        {
            provideDocumentFormattingEdits(document, options) {
                if (document.lineCount === 0) return [];

                const text = document.getText();
                const formatted = formatSkript(text, {
                    insertSpaces: options.insertSpaces,
                    tabSize: options.tabSize,
                    eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
                });
                if (formatted === text) return [];

                const fullRange = new vscode.Range(
                    document.lineAt(0).range.start,
                    document.lineAt(document.lineCount - 1).range.end
                );
                return [vscode.TextEdit.replace(fullRange, formatted)];
            }
        }
    );
}

// Registers the formatter when `skript.format.enabled` is true. Returns a
// disposable either way so the caller can toggle it on settings changes.
function register(context) {
    const settings = require('./settings');
    if (!settings.formatEnabled()) return { dispose() {} };
    const disposable = createIndentFormatter();
    context.subscriptions.push(disposable);
    return disposable;
}

module.exports = { formatSkript, stripComment, createIndentFormatter, register };
