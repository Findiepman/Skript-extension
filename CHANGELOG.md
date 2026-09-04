# Changelog

## 1.1.0

The extension moved from a single `extension.js` to `src/` modules built around one workspace index. Everything below reads from that index, so a function or variable edited in one file shows up everywhere as soon as it is re-indexed.

### Added

**Workspace index**
- Every `.sk` file in the workspace is indexed once on startup (in small concurrent batches, so the editor stays responsive) and then re-parsed one file at a time on change, create, delete or save. Positions are recorded for every variable, option, function and call, which is what makes navigation possible.
- Files whose name starts with `-` are indexed but flagged: Skript does not load them, so their entries show `(disabled)` and sort last.

**Function IntelliSense**
- Completion for every function defined in the workspace, inserted as a snippet with one tab stop per parameter.
- Hover on a call or on the definition line shows the signature, the `#d` / `#dp` / `#dr` / `#dex` / `#ddep` doc comments, and where the function is defined.
- Signature help after `name(` and on every `,`, with the active parameter highlighted and its `#dp` text.
- Go to Definition (F12) and Find All References for functions, workspace-wide.

**Variable and option navigation**
- Go to Definition on `{var}` jumps to the first write (`set` / `add` / `delete` …), preferring enabled files. Find All References lists every occurrence; locals stay inside the current file.
- `{@option}` resolves to the entry in the same file's `options:` block. Hover shows the option's value.
- Hover on any variable shows its kind, how many reads and writes it has, and the files it appears in.
- Nested variables such as `{slayer::%{_uuid}%::level}` resolve to the outer variable or the inner `{_uuid}` depending on where the cursor sits.

**Diagnostics** (Problems panel, source `skript`, each with a code so it can be switched off)
- `disabled-file`: the file name starts with `-`, so Skript will not load it.
- `mixed-indent`: a line indented with both tabs and spaces. Comes with a quick fix.
- `indent-after-colon`: a line ending in `:` that is not followed by a deeper-indented line (Skript's "Empty configuration section").
- `else-indent-mismatch`: an `else` / `else if` that does not line up with its `if`.
- `wait-in-inventory-click`: a `wait` inside `on inventory click:` with no `close … inventory` before it.
- `undefined-option`: `{@x}` with no `x` in this file's `options:` block.
- `local-never-set`: a `{_x}` that is read but never written in this file (function parameters are exempt).
- `unknown-function`: a call to a function that is not defined in any indexed file, not a Skript built-in, and not listed in `skript.diagnostics.knownFunctions`. Also flags functions that only exist in a disabled file.

**Grammar**
- `at <time>:` and `every <duration>:` headers, `aliases:` / `variables:` entries with `=`, `loop-value` / `loop-index` / `arg-1` / `event-slot` and the other built-in values, ending words (`stop`, `exit loop`, `exit 2 sections`, `cancel event`, `return`), function call sites (also inside `%…%`), and `#d` / `#dp` / `#dr` / `#dex` / `#ddep` doc comments.
- Scope assertions in `test/grammar/*.test.sk`, run with `npm run test:grammar`.

**Language configuration**
- `'` auto-closes outside strings only (so `{_p}'s uuid` is not affected).
- Enter after a line ending in `:` indents, but not when the colon is inside a string (`send "a:"`).
- Enter after `stop`, `exit loop`, `cancel event` or `return …` outdents.
- `#!FOLD` … `#!UNFOLD` comment markers fold, in addition to indentation folding.

**Theme**
- `Skript Tools Dark`, a Dark+ derived theme that colours every Skript scope, including each `&` colour code in its real Minecraft colour. Other themes can copy the rules from the README's "Colours on other themes" section.

**Snippets**
- Snippets are now contributed from `snippets/skript.json` (they show with the snippet icon and in *Insert Snippet*). New: `at time`, `every duration`, `exit loop`, `stop`, `giveSlayerItem`, `rollDrop else-if chain`, `doc-comment`. Removed: `nch set`, `dialogue line`, `quest stage check`, `quest stage set`, `givevoucher`.

**Settings** (all under `skript.*`, see the README)
- `scan.glob`, `scan.exclude`, `scan.includeDisabledFiles` for the index.
- `diagnostics.enabled`, `diagnostics.rules`, `diagnostics.knownFunctions`.
- `format.enabled`, `completion.preselectVariables`.

**Other**
- A "Skript Tools" output channel logs index scans and errors.
- `.vsix` packages stay untracked (`.gitignore`) and out of the package (`.vscodeignore`), along with the test folder.
- Node unit tests for the parser, providers, formatter and diagnostics (`npm test`) and a real-editor suite (`npm run test:editor`).

### Changed
- Minimum VS Code version is now 1.75.
- `package.json` `main` points at `src/index.js`; the old `extension.js` and its built-in snippet provider are gone.

## 1.0.1

- Reindent-on-save formatter, `{variable}` completion, syntax highlighting and snippets.
