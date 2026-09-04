const vscode = require('vscode');

// ── Variable store ──────────────────────────────────────────────────────────
// Maps variable name (without braces) → { kind, files }
// kind: 'global' | 'local' | 'list' | 'option'
const variableMap = new Map();

// Debounce timer for re-scans
let scanTimer = null;
const SCAN_DELAY_MS = 500;

// ── Variable scanning ───────────────────────────────────────────────────────

function classifyVariable(raw) {
    // raw is the content inside { }, e.g. "_tmp", "@prefix", "quest::*"
    if (raw.startsWith('@')) return 'option';
    if (raw.startsWith('_')) return 'local';
    if (raw.includes('::')) return 'list';
    return 'global';
}

function scanText(text, uri) {
    const filePath = uri.toString();
    // Match all {…} variable references
    const varRegex = /\{([^{}]+)\}/g;
    let match;
    while ((match = varRegex.exec(text)) !== null) {
        const name = match[1];
        // Skip standalone expression placeholders like %player% (no :: or other var structure)
        if (/^%[^%]+%$/.test(name)) continue;
        const kind = classifyVariable(name);
        if (variableMap.has(name)) {
            variableMap.get(name).files.add(filePath);
        } else {
            variableMap.set(name, { kind, files: new Set([filePath]) });
        }
    }

    // Also extract options: block definitions → synthesize @name entries
    const optionRegex = /^options\s*:\s*$/m;
    if (optionRegex.test(text)) {
        const lines = text.split('\n');
        let inOptions = false;
        for (const line of lines) {
            if (/^options\s*:/.test(line)) {
                inOptions = true;
                continue;
            }
            if (inOptions) {
                // Options block ends when we hit a non-indented, non-empty line
                if (line.length > 0 && !line.startsWith('\t') && !line.startsWith('  ') && line.trim().length > 0) {
                    inOptions = false;
                    continue;
                }
                const optMatch = line.match(/^\s+(\w[\w-]*)\s*[:=]/);
                if (optMatch) {
                    const optName = '@' + optMatch[1];
                    if (variableMap.has(optName)) {
                        variableMap.get(optName).files.add(filePath);
                    } else {
                        variableMap.set(optName, { kind: 'option', files: new Set([filePath]) });
                    }
                }
            }
        }
    }
}

async function scanWorkspace() {
    variableMap.clear();
    const files = await vscode.workspace.findFiles('**/*.sk', '**/node_modules/**', 500);
    for (const uri of files) {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            scanText(doc.getText(), uri);
        } catch (_) {
            // skip unreadable files
        }
    }
}

function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scanWorkspace(), SCAN_DELAY_MS);
}

// ── Skript snippet definitions ──────────────────────────────────────────────

function getSkriptSnippets() {
    return [
        // Effects
        { label: 'send', detail: 'Send message to player', insertText: 'send "${1:message}" to ${2:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'send actionbar', detail: 'Send actionbar message', insertText: 'send actionbar "${1:message}" to ${2:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'send title', detail: 'Send title + subtitle', insertText: 'send title "${1:title}" with subtitle "${2:subtitle}" to ${3:player} for ${4:3} seconds', kind: vscode.CompletionItemKind.Snippet },
        { label: 'broadcast', detail: 'Broadcast message', insertText: 'broadcast "${1:message}"', kind: vscode.CompletionItemKind.Snippet },
        { label: 'set', detail: 'Set variable', insertText: 'set {${1:var}} to ${2:value}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'add to', detail: 'Add to variable', insertText: 'add ${1:1} to {${2:var}}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'remove from', detail: 'Remove from variable', insertText: 'remove ${1:1} from {${2:var}}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'delete', detail: 'Delete variable', insertText: 'delete {${1:var}}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'give', detail: 'Give item to player', insertText: 'give ${1:player} ${2:1} of ${3:diamond}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'teleport', detail: 'Teleport entity', insertText: 'teleport ${1:player} to ${2:location}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'execute console command', detail: 'Run console command', insertText: 'execute console command "${1:command}"', kind: vscode.CompletionItemKind.Snippet },
        { label: 'execute player command', detail: 'Run command as player', insertText: 'make ${1:player} execute command "/${2:command}"', kind: vscode.CompletionItemKind.Snippet },
        { label: 'play sound', detail: 'Play sound to player', insertText: 'play sound "${1:block.note_block.bell}" with volume ${2:1} with pitch ${3:0.9} at ${4:player} for ${5:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'wait', detail: 'Wait duration', insertText: 'wait ${1:1} ${2|second,seconds,tick,ticks|}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'cancel event', detail: 'Cancel the event', insertText: 'cancel event', kind: vscode.CompletionItemKind.Snippet },
        { label: 'open chest', detail: 'Open chest GUI', insertText: 'open chest with ${1:3} rows named "${2:Menu}" to ${3:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'apply', detail: 'Apply potion effect', insertText: 'apply ${1:speed} ${2:1} to ${3:player} for ${4:30} seconds', kind: vscode.CompletionItemKind.Snippet },
        { label: 'spawn', detail: 'Spawn entity', insertText: 'spawn ${1:zombie} at ${2:location}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'kill', detail: 'Kill entity', insertText: 'kill ${1:entity}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'damage', detail: 'Damage entity', insertText: 'damage ${1:player} by ${2:5} hearts', kind: vscode.CompletionItemKind.Snippet },
        { label: 'heal', detail: 'Heal entity', insertText: 'heal ${1:player} by ${2:5} hearts', kind: vscode.CompletionItemKind.Snippet },
        { label: 'feed', detail: 'Feed player', insertText: 'feed ${1:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'close inventory', detail: 'Close player inventory', insertText: 'close ${1:player}\'s inventory', kind: vscode.CompletionItemKind.Snippet },
        { label: 'drop', detail: 'Drop item', insertText: 'drop ${1:1} of ${2:diamond} at ${3:location}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'push', detail: 'Push entity', insertText: 'push ${1:player} ${2:forwards} at speed ${3:1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'replace', detail: 'Replace in text', insertText: 'replace all "${1:find}" in {_${2:text}} with "${3:replace}"', kind: vscode.CompletionItemKind.Snippet },

        // Control flow
        { label: 'if', detail: 'If statement', insertText: 'if ${1:condition}:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'else if', detail: 'Else if branch', insertText: 'else if ${1:condition}:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'else', detail: 'Else branch', insertText: 'else:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'loop', detail: 'Loop', insertText: 'loop ${1:all players}:\n\t${2:loop-value}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'loop times', detail: 'Loop N times', insertText: 'loop ${1:10} times:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'while', detail: 'While loop', insertText: 'while ${1:condition}:\n\t${2}\n\twait 1 tick', kind: vscode.CompletionItemKind.Snippet },

        // Top-level structures
        { label: 'command', detail: 'Command definition', insertText: 'command /${1:name} ${2:<text>}:\n\ttrigger:\n\t\t${3}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on event', detail: 'Event handler', insertText: 'on ${1:join}:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'function', detail: 'Function definition', insertText: 'function ${1:name}(${2:p: player})${3: :: text}:\n\t${4}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'options', detail: 'Options block', insertText: 'options:\n\t${1:prefix}: ${2:value}', kind: vscode.CompletionItemKind.Snippet },

        // Common events
        { label: 'on join', detail: 'Player join event', insertText: 'on join:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on quit', detail: 'Player quit event', insertText: 'on quit:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on break', detail: 'Block break event', insertText: 'on break:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on place', detail: 'Block place event', insertText: 'on place:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on right click', detail: 'Right click event', insertText: 'on right click:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on inventory click', detail: 'Inventory click event', insertText: 'on inventory click:\n\tcancel event\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on death', detail: 'Death event', insertText: 'on death of ${1:player}:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on respawn', detail: 'Respawn event', insertText: 'on respawn:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on chat', detail: 'Chat event', insertText: 'on chat:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on damage', detail: 'Damage event', insertText: 'on damage:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'on load', detail: 'Script load event', insertText: 'on load:\n\t${1}', kind: vscode.CompletionItemKind.Snippet },

        // Common conditions
        { label: 'if player has permission', detail: 'Permission check', insertText: 'if ${1:player} has permission "${2:perm.node}":\n\t${3}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'if player is op', detail: 'Op check', insertText: 'if ${1:player} is op:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'if is set', detail: 'Variable is set check', insertText: 'if {${1:var}} is set:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'if is not set', detail: 'Variable not set check', insertText: 'if {${1:var}} is not set:\n\t${2}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'if inventory can hold', detail: 'Inventory space check', insertText: 'if ${1:player}\'s inventory can hold ${2:item}:\n\t${3}', kind: vscode.CompletionItemKind.Snippet },

        // PrimalMines-specific patterns
        { label: 'nch set', detail: 'NoieCitizenHide visibility', insertText: 'execute console command "nch set %${1:player}% ${2:npcid} ${3|hide,show|}"', kind: vscode.CompletionItemKind.Snippet },
        { label: 'talking lock', detail: 'NPC talking lock pattern', insertText: 'if {npc::talking::%${1:player}%} is set:\n\tstop\nset {npc::talking::%${1:player}%} to true\n${2}\ndelete {npc::talking::%${1:player}%}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'dialogue line', detail: 'Actionbar dialogue with sound', insertText: 'send actionbar "${1:message}" to ${2:player}\nplay sound "block.note_block.bell" with volume 1 with pitch 0.9 at ${2:player} for ${2:player}\nwait ${3:2} seconds', kind: vscode.CompletionItemKind.Snippet },
        { label: 'quest stage check', detail: 'Check quest stage', insertText: 'if {quest::%${1:player}\'s uuid%::${2:questname}::stage} is ${3:1}:\n\t${4}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'quest stage set', detail: 'Set quest stage', insertText: 'set {quest::%${1:player}\'s uuid%::${2:questname}::stage} to ${3:2}\n${4:updateNPCVisibility(${1:player})}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'stash fallback', detail: 'Give item with stash fallback', insertText: 'if ${1:player}\'s inventory can hold ${2:item}:\n\tgive ${1:player} 1 of ${2:item}\nelse:\n\tadd ${2:item} to {stash::%${1:player}\'s uuid%::*}\n\tsend "&cCould not pick up item! Collect it with /stash." to ${1:player}', kind: vscode.CompletionItemKind.Snippet },
        { label: 'givevoucher', detail: 'Give rank voucher', insertText: 'execute console command "givevoucher ${1|Gladiator,Sentinel,Paragon|} %${2:player}%"', kind: vscode.CompletionItemKind.Snippet },
        { label: 'updateNPCVisibility', detail: 'Call NPC visibility update', insertText: 'updateNPCVisibility(${1:player})', kind: vscode.CompletionItemKind.Snippet },
    ];
}

// ── Completion provider ─────────────────────────────────────────────────────

function createVariableProvider() {
    // Regex that treats {…} as a single word — passed explicitly to
    // getWordRangeAtPosition so we never depend on cached language config.
    const VAR_WORD = /\{[^}]*\}?|\w+/;

    return vscode.languages.registerCompletionItemProvider(
        { language: 'skript', scheme: 'file' },
        {
            provideCompletionItems(document, position, _token, _context) {
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

                for (const [name, info] of variableMap) {
                    if (isOption && info.kind !== 'option') continue;
                    if (isLocal && info.kind !== 'local') continue;

                    const fullVar = `{${name}}`;
                    const item = new vscode.CompletionItem(
                        fullVar,
                        info.kind === 'option' ? vscode.CompletionItemKind.Constant
                            : info.kind === 'local' ? vscode.CompletionItemKind.Variable
                            : info.kind === 'list' ? vscode.CompletionItemKind.Struct
                            : vscode.CompletionItemKind.Field
                    );
                    item.detail = info.kind + ' variable';
                    item.documentation = `Found in ${info.files.size} file(s)`;

                    item.insertText = fullVar;

                    // Explicit range forces VS Code to replace the entire {typed}
                    // word — both in insert (Tab) and replace (Enter) modes.
                    item.range = replaceRange;

                    let baseName = name;
                    if (baseName.includes('::')) baseName = baseName.split('::')[0];
                    item.filterText = `{${baseName}}`;

                    item.sortText = info.kind === 'list' ? `0a_${baseName}` : `0b_${name}`;
                    item.preselect = true;

                    items.push(item);
                }

                return new vscode.CompletionList(items, true);
            }
        },
        '{' // trigger character
    );
}

function createSnippetProvider() {
    return vscode.languages.registerCompletionItemProvider(
        { language: 'skript', scheme: 'file' },
        {
            provideCompletionItems(_document, _position, _token, _context) {
                const snippets = getSkriptSnippets();
                return snippets.map(s => {
                    const item = new vscode.CompletionItem(s.label, s.kind);
                    item.detail = s.detail;
                    item.insertText = new vscode.SnippetString(s.insertText);
                    item.sortText = `1_${s.label}`;
                    return item;
                });
            }
        }
    );
}

// ── Format on save (reindent) ───────────────────────────────────────────────
// Skript has no closing braces — nesting is defined purely by indentation,
// the same way Python's is. So "reformat" can't be derived from keywords
// alone (an "if" block ends whenever the source dedents, there's no "end").
// Instead we normalize: walk the file with a stack of the ORIGINAL indent
// widths already present, snap each line's depth to its place in that
// stack, and re-emit it using the editor's configured indent unit (tabs or
// spaces, whichever the user has set). This is exactly what fixes the
// common case of pasted snippets with mismatched tabs/spaces or a stray
// space, while leaving correctly-nested code untouched.

function createIndentFormatter() {
    return vscode.languages.registerDocumentFormattingEditProvider(
        { language: 'skript', scheme: 'file' },
        {
            provideDocumentFormattingEdits(document, options) {
                if (document.lineCount === 0) return [];

                const indentUnit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
                const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

                // Stack of {origWidth, outLevel}; root is column 0 / level 0.
                const stack = [{ origWidth: 0, outLevel: 0 }];
                const outLines = [];

                for (let i = 0; i < document.lineCount; i++) {
                    const raw = document.lineAt(i).text;
                    const line = raw.replace(/[ \t]+$/, ''); // strip trailing whitespace

                    if (line.trim().length === 0) {
                        outLines.push('');
                        continue;
                    }

                    const leading = line.match(/^[ \t]*/)[0];
                    const content = line.slice(leading.length);

                    // Tabs count as 4 "columns" purely so mixed tab/space
                    // indentation still compares consistently; it's never
                    // written back out, only used to rank depth.
                    let origWidth = 0;
                    for (const ch of leading) origWidth += ch === '\t' ? 4 : 1;

                    while (stack.length > 1 && stack[stack.length - 1].origWidth > origWidth) {
                        stack.pop();
                    }
                    const top = stack[stack.length - 1];
                    let outLevel;
                    if (origWidth > top.origWidth) {
                        outLevel = top.outLevel + 1;
                        stack.push({ origWidth, outLevel });
                    } else {
                        outLevel = top.outLevel;
                    }

                    outLines.push(indentUnit.repeat(outLevel) + content);
                }

                const fullRange = new vscode.Range(
                    document.lineAt(0).range.start,
                    document.lineAt(document.lineCount - 1).range.end
                );
                return [vscode.TextEdit.replace(fullRange, outLines.join(eol))];
            }
        }
    );
}

// ── Activation ──────────────────────────────────────────────────────────────

function activate(context) {
    // Initial workspace scan
    scanWorkspace();

    // Re-scan on document changes (debounced)
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'skript') {
                scheduleScan();
            }
        })
    );

    // Re-scan when .sk files are created/deleted
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.sk');
    watcher.onDidCreate(() => scheduleScan());
    watcher.onDidDelete(() => scheduleScan());
    watcher.onDidChange(() => scheduleScan());
    context.subscriptions.push(watcher);

    // Register providers
    context.subscriptions.push(createVariableProvider());
    context.subscriptions.push(createSnippetProvider());
    context.subscriptions.push(createIndentFormatter());
}

function deactivate() {
    if (scanTimer) clearTimeout(scanTimer);
    variableMap.clear();
}

module.exports = { activate, deactivate };
