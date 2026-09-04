# Skript Extension

Skript (`.sk`) language support for VS Code: syntax highlighting, a snippet library, workspace-aware IntelliSense for `{variables}`, `{@options}` and functions, navigation, and diagnostics for the mistakes Skript rejects at load time.

## Features

**Syntax highlighting** — full TextMate grammar for Skript: `on` / `at` / `every` event headers, commands and their sub-properties, functions with `:: type` return, `options:` / `aliases:` / `variables:` sections and their entries, local/global/list variables, options, built-in values (`loop-value`, `arg-1`, `event-slot`, `player`, `attacker` …), ending words (`stop`, `exit loop`, `cancel event`, `return`), function calls, `#d` / `#dp` / `#dr` doc-comments, and inline Minecraft `&`-colour formatting (`&a&lText` is green *and* bold, `&#RRGGBB` / `<##RRGGBB>` hex, `%expr%` interpolation). Run `npm run test:grammar` for the scope assertions in `test/grammar/`.

**Skript Tools Dark theme** — a Dark+ derived colour theme that renders every Skript scope, including each `&` colour code in its real Minecraft colour. Pick it with *Preferences: Color Theme* → **Skript Tools Dark**. See [Colours on other themes](#colours-on-other-themes) for using another theme.

**Snippets** — common effects, control flow, event handlers, conditions, and PrimalMines patterns (talking lock, stash fallback, `giveSlayerItem`, `rollDrop` else-if chain, `updateNPCVisibility`, doc-comment block). Contributed from `snippets/skript.json`, so they show up in the completion list with the snippet icon and in *Insert Snippet*.

**Typing helpers** — Enter after a line ending in `:` indents (but not after `send "a:"`, where the colon is inside a string), Enter after `stop` / `exit loop` / `cancel event` / `return …` outdents, `'` auto-closes outside strings, and `#!FOLD` … `#!UNFOLD` comment markers fold in addition to indentation folding.

**Workspace index** — every `.sk` file in the workspace is indexed once on startup and then re-parsed one file at a time on change, create, delete or save (debounced). Files whose name starts with `-` are indexed too, but Skript does not load them, so their entries are marked `(disabled)` and sort last (turn this off with `skript.scan.includeDisabledFiles`). The "Skript Tools" output channel logs each scan.

**Variable IntelliSense** — type `{` to complete any variable seen in the workspace, distinguishing local (`_var`), global, list (`var::*`), and option (`@var`) variables; `{_` shows only locals and `{@` only options. Go to Definition on a `{variable}` jumps to its first write (`set` / `add` / `delete` …), Find All References lists every occurrence (locals stay inside the current file), and hover shows the kind, read/write counts and the files it appears in. `{@option}` resolves to the entry in the same file's `options:` block; hover shows its value. Nested variables such as `{slayer::%{_uuid}%::level}` resolve to the outer variable or the inner `{_uuid}` depending on where the cursor sits.

**Function IntelliSense** — completion for every `function name(...)` in the workspace (inserted with one tab stop per parameter), hover with the signature and doc comments, signature help after `name(` and on each `,`, Go to Definition and Find All References. Everything reads the live index, so a function edited in another file is picked up as soon as it is re-indexed. See [Doc comments](#doc-comments) for how to document a function.

**Diagnostics** — indentation mistakes, `wait` inside `on inventory click`, undefined `{@options}`, never-set locals and unknown function calls show up in the Problems panel with a code each, so any rule can be switched off. See [Diagnostics](#diagnostics).

**Reindent on save** — format-on-save is enabled by default for `.sk` files only. Skript has no closing braces, so nesting *is* the indentation and there is nothing else to derive it from. The formatter therefore fixes exactly the things Skript would reject at load time, and leaves everything else alone:

- a line indented deeper than the previous line when that line did not end in `:` (snapped back to its sibling level);
- a line at the same depth as the `:` line above it (pulled into that section);
- a dedent to a depth no enclosing section uses (snapped to the nearest valid depth);
- an `else` / `else if` sitting inside the body of its own `if` (moved up to line up with it);
- an `on …:`, `command /…:`, `function …:`, `every …:`, `options:` header that is not at column 0.

A correction is carried through the whole block that follows it, so a chunk pasted at the wrong depth is shifted as one unit and keeps its internal nesting. Strings and comments are respected (`send "a:"` and `# todo:` are not section openers; `<#F05532>` inside a string is not a comment). Mixed tabs/spaces are normalized to whatever the editor is set to, and trailing whitespace is stripped. Valid code never has its nesting changed. Run `npm test` for the test-suite.

**Enter doesn't hijack autocomplete** — `editor.acceptSuggestionOnEnter` is set to `off` for `.sk` files only, so pressing Enter always just makes a new line. Only Tab or a click accepts a suggestion. This is scoped to Skript files; it doesn't touch the setting for any other language.

## Doc comments

A run of `#` comments directly above a `function` line documents it. Plain `#` lines become the description; the tagged forms are:

| Tag | Meaning |
|-----|---------|
| `#d text` | description (several `#d` lines are joined) |
| `#dp name text` | describes the parameter `name` |
| `#dr text` | describes the return value |
| `#dex code` | an example (several `#dex` lines are joined) |
| `#ddep reason` | marks the function deprecated; completion strikes it through |

```skript
#d Rolls a drop chance, boosted by the Plunder enchant on the player's tool.
#dp p the player who killed the boss
#dp chance percent chance before Plunder is applied
#dr true when the drop should be given
#dex if rollDrop({_a}, 10):
function rollDrop(p: player, chance: number) :: boolean:
    ...
```

Hover, completion and signature help show the description, a parameter table, the return type, the example and the defining file.

## Diagnostics

Problems are reported with source `skript` and one of these codes:

| Code | Severity | What it catches |
|------|----------|-----------------|
| `disabled-file` | Info | the file name starts with `-`, so Skript will not load it (shown on line 1) |
| `mixed-indent` | Error | a code line indented with both tabs and spaces; the lightbulb offers a quick fix, and format-on-save repairs it too |
| `indent-after-colon` | Error | a line ending in `:` (outside strings, a trailing `#` comment is fine) whose next code line is not indented deeper — Skript's "Empty configuration section" |
| `else-indent-mismatch` | Error | an `else` / `else if` that does not line up with the nearest `if` / `else if` (or implicit condition) at the same or a shallower depth; a tab counts as 4 columns for the comparison |
| `wait-in-inventory-click` | Warning | a `wait` inside an `on inventory click:` section with no `close … inventory` line before it in that section |
| `undefined-option` | Error | `{@x}` with no `x` in this file's `options:` block |
| `local-never-set` | Warning | a `{_x}` (or `{_x::…}`) that is read but never written in this file; function parameters are exempt |
| `unknown-function` | Warning | a call to a function not defined in any indexed file, not a Skript built-in (`round`, `random`, `location`, `vector`, …) and not in `skript.diagnostics.knownFunctions`; also reported when the only definition is in a disabled file |

Diagnostics run when a Skript file is opened, 400 ms after it changes, and whenever the workspace index updates (so `unknown-function` follows definitions in other files). To switch off one rule, set its code to `false`:

```jsonc
"skript.diagnostics.rules": {
  "local-never-set": false
}
```

Set `skript.diagnostics.enabled` to `false` to turn all of them off. Functions that come from an addon or another server go in `skript.diagnostics.knownFunctions`.

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `skript.scan.glob` | `"**/*.sk"` | files to index; changing it rescans the workspace |
| `skript.scan.exclude` | `"**/node_modules/**"` | files to leave out of the index; changing it rescans |
| `skript.scan.includeDisabledFiles` | `true` | index `-name.sk` files and mark their entries `(disabled)`; `false` skips them entirely |
| `skript.diagnostics.enabled` | `true` | report problems in the Problems panel |
| `skript.diagnostics.rules` | `{}` | per-code toggles, e.g. `{ "wait-in-inventory-click": false }`; unlisted codes stay on |
| `skript.diagnostics.knownFunctions` | `[]` | function names defined outside the workspace that `unknown-function` should accept |
| `skript.format.enabled` | `true` | register the reindent formatter (format-on-save is on for `.sk` files by default) |
| `skript.completion.preselectVariables` | `false` | preselect the closest matching variable in the `{…}` completion list |

The extension also sets two editor defaults for `.sk` files only: `editor.formatOnSave: true` and `editor.acceptSuggestionOnEnter: "off"`.

## Colours on other themes

Stock VS Code themes only colour the generic part of a scope (`variable`, `keyword`, `string` …), so on Dark+, Monokai, etc. Skript still looks fine but the Skript-specific distinctions are lost: a `{_local}` and a `{global}` look the same, and `&a` text is plain string colour. To colour them on any theme, add rules to `editor.tokenColorCustomizations` in your settings:

```jsonc
"editor.tokenColorCustomizations": {
  "textMateRules": [
    { "scope": "variable.other.local.skript",         "settings": { "foreground": "#9CDCFE" } },
    { "scope": "variable.other.global.skript",        "settings": { "foreground": "#4FC1FF" } },
    { "scope": "constant.other.option.skript",        "settings": { "foreground": "#D7BA7D" } },
    { "scope": "variable.language.skript",            "settings": { "foreground": "#569CD6", "fontStyle": "italic" } },
    { "scope": "keyword.control.flow.end.skript",     "settings": { "foreground": "#C586C0", "fontStyle": "bold" } },
    { "scope": "keyword.control.event.skript",        "settings": { "foreground": "#C586C0" } },
    { "scope": "entity.name.type.event.skript",       "settings": { "foreground": "#4EC9B0", "fontStyle": "bold" } },
    { "scope": "entity.name.function.command.skript", "settings": { "foreground": "#DCDCAA", "fontStyle": "bold" } },
    { "scope": "entity.name.function.call.skript",    "settings": { "foreground": "#DCDCAA" } },
    { "scope": "support.type.property.skript",        "settings": { "foreground": "#569CD6", "fontStyle": "italic" } },
    { "scope": "variable.parameter.skript",           "settings": { "foreground": "#9CDCFE", "fontStyle": "italic" } },
    { "scope": "constant.character.escape.hex.skript","settings": { "foreground": "#D7BA7D", "fontStyle": "bold" } },
    { "scope": "markup.inline.mc.green.skript",       "settings": { "foreground": "#55FF55" } },
    { "scope": "markup.bold.mc.skript",               "settings": { "fontStyle": "bold" } }
  ]
}
```

All Skript scopes, for reference:

| Scope | What it covers |
|-------|----------------|
| `keyword.control.event.skript` / `entity.name.type.event.skript` | `on`, `at`, `every` and the event text after them |
| `keyword.other.command.skript` / `entity.name.function.command.skript` / `variable.parameter.skript` | `command`, `/name`, `<args>` |
| `keyword.other.function-def.skript` / `entity.name.function.skript` / `keyword.operator.return-type.skript` / `support.type.return.skript` | `function`, its name, `::`, return type |
| `entity.name.function.call.skript` | `name(` call sites, also inside `%…%` |
| `keyword.other.section.skript` | `options:`, `aliases:`, `variables:`, `permissions:` |
| `variable.other.alias.skript` / `variable.other.default.skript` / `keyword.operator.assignment.skript` | `name = …` entries in `aliases:` / `variables:` |
| `support.type.property.skript` | `trigger:`, `permission:`, `cooldown:` … |
| `variable.other.local.skript` / `variable.other.global.skript` / `constant.other.option.skript` | `{_x}`, `{x}`, `{@x}` |
| `variable.language.skript` | `loop-value`, `loop-index`, `arg-1`, `arg-text`, `event-slot`, `player`, `victim`, `attacker`, `shooter`, `sender`, `console` |
| `keyword.control.flow.end.skript` | `stop`, `exit loop`, `exit 2 sections`, `cancel event`, `return` |
| `keyword.control.skript` / `keyword.other.effect.skript` / `keyword.operator.word.skript` / `keyword.operator.logical.skript` | `if` / `loop` / `while`, effects, conditions, `and` / `or` |
| `string.quoted.double.skript` / `variable.other.interpolation.skript` / `constant.character.escape.percent.skript` | strings, `%expr%`, `%%` |
| `constant.character.escape.hex.skript` / `constant.character.escape.tag.skript` / `constant.character.escape.skript` | `&#RRGGBB`, `<##RRGGBB>`, `<green>`, `&&` |
| `punctuation.definition.escape.minecraft.skript` / `punctuation.definition.escape.minecraft.format.skript` | the `&a` / `&l` / `&r` code itself |
| `markup.inline.mc.<colour>.skript` | text after a colour code; `<colour>` is one of `black`, `dark-blue`, `dark-green`, `dark-aqua`, `dark-red`, `dark-purple`, `gold`, `gray`, `dark-gray`, `blue`, `green`, `aqua`, `red`, `light-purple`, `yellow`, `white` |
| `markup.bold.mc.skript` / `markup.italic.mc.skript` / `markup.underline.mc.skript` / `markup.strikethrough.mc.skript` / `markup.obfuscated.mc.skript` | text after `&l` / `&o` / `&n` / `&m` / `&k` (nested inside the colour scope) |
| `comment.line.documentation.skript` / `keyword.other.documentation.skript` / `variable.parameter.documentation.skript` | `#d`, `#dp name`, `#dr`, `#dex`, `#ddep` doc-comments |
| `support.type.skript` / `constant.language.boolean.skript` / `constant.language.null.skript` / `constant.numeric.skript` | types, `true` / `false`, `nothing`, numbers |

## Install

1. Download the `.vsix` from a [release](https://github.com/findiepman/skript-extension/releases), or build one yourself (see below).
2. In VS Code: Extensions panel → `...` menu → **Install from VSIX...** → select the file.

## Build from source

```
npm install -g @vscode/vsce
vsce package --no-dependencies --allow-missing-repository
```

## Structure

```
package.json                     manifest: language, grammar, snippets, theme, settings, config defaults
src/index.js                     activate / deactivate: wires the modules below
src/scanner.js                   the workspace index (per-file entries with positions, onDidUpdate)
src/parser.js                    text -> variables / options / functions / calls (pure; test/parser.test.js)
src/settings.js                  typed getters for every skript.* setting
src/formatter.js                 reindent logic + formatter registration (pure core; test/formatter.test.js)
src/diagnostics.js               the rules above + quick fix (pure core; test/diagnostics.test.js)
src/log.js                       the "Skript Tools" output channel
src/providers/variables.js       {…} completion
src/providers/functions.js       function completion, hover, signature help
src/providers/navigation.js      go-to-definition, references and hover for functions, variables, options
language-configuration.json      comments, brackets, indent / onEnter rules, folding markers
syntaxes/skript.tmLanguage.json  TextMate grammar (tested by test/grammar/*.test.sk, npm run test:grammar)
snippets/skript.json             snippet contribution
themes/skript-tools-dark-color-theme.json  "Skript Tools Dark" colour theme
test/                            node unit tests (npm test), grammar tests, fixtures, real-editor suite (npm run test:editor)
icons/skript.png                 file icon for .sk files
```

## License

MIT — see [LICENSE](./LICENSE).
