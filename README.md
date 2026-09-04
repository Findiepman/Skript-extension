# Skript Extension

Skript (`.sk`) language support for VS Code: syntax highlighting, a snippet library, and workspace-aware `{variable}` IntelliSense.

## Features

**Syntax highlighting** — full TextMate grammar for Skript: events, commands, functions, sections, local/global/list variables, options, and inline Minecraft `&`-color-code formatting.

**Snippets** — common effects, control flow, event handlers, conditions, and a few PrimalMinesCore-specific patterns (NPC visibility, quest stage checks, stash fallback, etc.). See `extension.js` → `getSkriptSnippets()`.

**Variable IntelliSense** — scans every `.sk` file in the workspace for `{variable}` references and `options:` blocks, then autocompletes `{...}` as you type, distinguishing local (`_var`), global, list (`var::*`), and option (`@var`) variables. Re-scans on save/create/delete, debounced.

**Reindent on save** — format-on-save is enabled by default for `.sk` files only. Because Skript has no closing braces, nesting is defined purely by indentation (like Python), so this normalizes whatever indent structure is already in the file — mixed tabs/spaces, a pasted snippet with the wrong width — to consistent tabs (or spaces, whichever your editor is set to), rather than trying to re-derive nesting from keywords alone.

**Enter doesn't hijack autocomplete** — `editor.acceptSuggestionOnEnter` is set to `off` for `.sk` files only, so pressing Enter always just makes a new line. Only Tab or a click accepts a suggestion. This is scoped to Skript files; it doesn't touch the setting for any other language.

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
package.json                     manifest: language, grammar, snippets, config defaults
extension.js                     activation, variable scanner, completion providers, formatter
language-configuration.json      comments, brackets, indent rules for typing
syntaxes/skript.tmLanguage.json  TextMate grammar
icons/skript.png                 file icon for .sk files
```

## License

MIT — see [LICENSE](./LICENSE).
