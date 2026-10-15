# A design per session, with conflict protection: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Claude Code session its own design file, and refuse an edit when another process changed the design file underneath the server.

**Architecture:** Two pure functions in `src/designs.js` choose the design file and its label. `src/server.js` uses them, remembers the file's modification stamp, and checks it (`guardExternal()`) before every edit, undo and redo. Server behaviour is tested over real MCP with the SDK client against temp `HOME` folders.

**Tech Stack:** Node 18+ ES modules, `node:test`, `@modelcontextprotocol/sdk` (server and client), `zod`.

**Spec:** `docs/superpowers/specs/2026-10-15-session-designs-design.md`

## Global Constraints

- stdout belongs to the MCP protocol; log only to stderr (`console.error`).
- Every design change goes through `mutate()` in `server.js`. A failed edit leaves the design unchanged.
- `ModelError` messages reach the user verbatim.
- The file choice order is exactly: `BREADBOARD_DESIGN`, then `~/.breadboard-bench/sessions/<CLAUDE_CODE_SESSION_ID>.json`, then `~/.breadboard-bench/design.json`. A session id counts only if it matches `^[A-Za-z0-9_-]+$`.
- The conflict message is exactly: `Another session changed this design (now N parts, M wires). Check it with get_design and repeat your edit.` The unreadable-file variant is `Another session changed this design. Check it with get_design and repeat your edit.`
- The legacy `~/.breadboard-mcp/design.json` fallback applies only to the shared file.
- `npm test` stays green; `npm test` runs `node --test test/*.test.js`, so helpers go in `test/helpers/`, not `test/*.test.js`.

## Review Focus

- A session id with path characters (`../x`, `a/b`, empty) must fall back to the shared file, never escape the folder. Pinned in Task 1.
- A session that never edits leaves no file or folder behind, and the first edit creates the folder. Pinned in Task 2.
- No `CLAUDE_CODE_SESSION_ID` (Claude Desktop) keeps using `design.json`. Pinned in Tasks 1 and 2.
- Another process writing inside this server's 1.5 s own-write window (the watcher ignores it) is still refused at the next edit. Pinned in Task 3.
- The design file deleted by someone else is not a conflict, and the next edit recreates it. Pinned in Task 3.
- An unreadable or half-written file refuses the edit with the no-counts message, leaves the design unchanged, and a repeat call goes through. Pinned in Task 3.

---

### Task 1: Choose the design file and its label

**Files:**
- Modify: `src/designs.js`
- Test: `test/designs.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `designPathFor(env: object, home: string) -> { file: string, kind: 'override' | 'session' | 'shared' }`
  - `designLabel(file: string, kind: string) -> string`

- [ ] **Step 1: Write the failing tests** in `test/designs.test.js`
  - `designPathFor prefers BREADBOARD_DESIGN`: env `{ BREADBOARD_DESIGN: '/x/y.json', CLAUDE_CODE_SESSION_ID: 'abc' }`, home `/h` gives `{ file: '/x/y.json', kind: 'override' }`.
  - `designPathFor uses the session file`: env `{ CLAUDE_CODE_SESSION_ID: '0c1d338e-d098-4028' }` gives `{ file: '/h/.breadboard-bench/sessions/0c1d338e-d098-4028.json', kind: 'session' }`.
  - `designPathFor falls back to the shared file`: env `{}` gives `{ file: '/h/.breadboard-bench/design.json', kind: 'shared' }`.
  - `designPathFor ignores an unsafe session id`: for each of `'../x'`, `'a/b'`, `''`, `'a b'`, the result has `kind: 'shared'`.
  - `designLabel`: a session file gives `session 0c1d338e` (first 8 characters of the id); the shared file gives `design.json`; an override file `/x/y.json` gives `y.json`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/designs.test.js`
Expected: FAIL, `designPathFor is not a function` (or `store.designPathFor` undefined).

- [ ] **Step 3: Implement both functions in `src/designs.js`.** `designPathFor` checks the three rules in order using `path.join`. `designLabel` takes the base name; for kind `session` it returns `session ${id.slice(0, 8)}` where `id` is the base name without `.json`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all pass (36 plus the new tests).

- [ ] **Step 5: Commit**

```bash
git add src/designs.js test/designs.test.js
git commit -m "Choose a design file per session"
```

---

### Task 2: Use the per-session file in the server, and show which one

**Files:**
- Create: `test/helpers/mcp.js`, `test/session.test.js`
- Modify: `src/server.js` (constants at the top, `load()`, `view()`, `viewerLine()`), `public/index.html` (the `#meta` line in `render()`)

**Interfaces:**
- Consumes: `designPathFor`, `designLabel` from Task 1.
- Produces:
  - `startServer({ env?: object }) -> Promise<{ call(name: string, args?: object) -> Promise<{ text: string, isError: boolean }>, port: number, home: string, stop() -> Promise<void> }>` in `test/helpers/mcp.js`. It makes a temp `HOME`, starts `node src/server.js` through the SDK's `Client` and `StdioClientTransport`, and sets `BREADBOARD_PORT` to a random port between 5300 and 5900. Its environment is `process.env` with `CLAUDE_CODE_SESSION_ID` and `BREADBOARD_DESIGN` removed (this very session sets the first one), then `env` applied on top, then `HOME` set to the temp folder. It reads the real port from the `get_viewer_url` text.
  - The state payload gains `file: string` (the label); `get_viewer_url` text gains a line `Design file: <label>`; `load()` and `DESIGN_PATH` come from `designPathFor`.

- [ ] **Step 1: Write the helper** `test/helpers/mcp.js` as described above.

- [ ] **Step 2: Write the failing tests** in `test/session.test.js`
  - `a session gets its own file, created on the first edit`: start with `CLAUDE_CODE_SESSION_ID: '0c1d338e-d098-4028'`. Before any edit, `<home>/.breadboard-bench` does not exist. After `call('new_design', {})`, `<home>/.breadboard-bench/sessions/0c1d338e-d098-4028.json` exists and `<home>/.breadboard-bench/design.json` does not. `get_viewer_url` text contains `Design file: session 0c1d338e`. `GET http://127.0.0.1:<port>/api/state` has `file === 'session 0c1d338e'`.
  - `without a session id the shared file is used`: after `new_design`, `<home>/.breadboard-bench/design.json` exists, and the state `file` is `design.json`.
  - `BREADBOARD_DESIGN overrides the session file`: with both `BREADBOARD_DESIGN: <tmp>/mine.json` and a session id, the edit writes `mine.json`, and the state `file` is `mine.json`.
  - `the legacy file is only read for the shared file`: put a valid design named `Legacy` at `<home>/.breadboard-mcp/design.json`. With no session id, `get_design` shows `Legacy`; with a session id, it shows `Untitled`.

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL (wrong file, missing `Design file` line, `file` undefined).

- [ ] **Step 4: Implement in `src/server.js`.** Replace the `DESIGN_PATH` constant with `const { file: DESIGN_PATH, kind: DESIGN_KIND } = store.designPathFor(process.env, os.homedir())` and keep `DESIGN_LABEL = store.designLabel(DESIGN_PATH, DESIGN_KIND)`. In `load()`, apply the legacy fallback only when `DESIGN_KIND === 'shared'`. Add `file: DESIGN_LABEL` to the object returned by `view()`. Add the `Design file: …` line to `viewerLine()`. In `public/index.html`, prefix the `#meta` text with `${state.file} · ` when `state.file` is set.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Check the header by eye.** Start a server with a session id on a spare port, open it in headless Chromium or a browser, and confirm the header reads `session <first 8> · …`. (The viewer has no automated tests.)

- [ ] **Step 7: Commit**

```bash
git add src/server.js public/index.html test/helpers/mcp.js test/session.test.js
git commit -m "Use a design file per session and show which one"
```

---

### Task 3: Refuse edits when the file changed under the server

**Files:**
- Modify: `src/server.js` (`persist()`, the file watcher, `mutate()`, `undo()`, `redo()`)
- Test: `test/session.test.js`

**Interfaces:**
- Consumes: `startServer` from Task 2; `M.ModelError`.
- Produces: in `server.js`, `stamp() -> string | null` (modification time and size of `DESIGN_PATH`, `null` if the file is missing), `reloadFromDisk() -> boolean` (reads the file, replaces the design, clears both history stacks, bumps `rev`, broadcasts, refreshes `seen`; `false` if the file can't be read or parsed), `guardExternal() -> void` (throws the `ModelError`s from Global Constraints), and a `seen` variable refreshed after load, persist and reload. The watcher calls `reloadFromDisk()`.

- [ ] **Step 1: Write the failing tests** in `test/session.test.js`. All use two servers (`a`, `b`) with the same `BREADBOARD_DESIGN` temp file, started before the file exists. Do the second server's call straight after the first one's write, so the 800 ms watcher cannot have caught up (comment this in the test).
  - `an edit is refused after another server changed the file`: `b.call('place_part', { type: 'bme280-3v3', at: 'f40' })` succeeds, then `a.call('place_part', { type: 'esp32-s3-devkitc-1', at: 'b8' })` has `isError` true and text matching `/^Another session changed this design \(now 1 parts, 0 wires\)\. Check it with get_design and repeat your edit\.$/`. The file's contents are identical before and after the refused call. `a.call('get_design')` then lists the BME280. A repeat of `a`'s `place_part` succeeds, and the file then has both parts.
  - `the browser gets the same refusal`: after another `b` edit (`set_part_props`, or any `place_part`), a `POST http://127.0.0.1:<a.port>/api/op` with header `x-breadboard: 1`, content type `application/json` and body `{"op":"remove_part","id":"U1"}` returns JSON `{ ok: false, error }` where `error` starts with `Another session changed this design`.
  - `undo is also guarded`: after the same kind of external change, `a.call('undo')` is refused with the same message.
  - `a deleted file is not a conflict`: delete the file after `a`'s write. Then `a.call('place_part', …)` succeeds and the file exists again.
  - `an unreadable file refuses once, without counts`: after `a`'s write, write `{ not json` to the file. `a`'s next edit has `isError` true with the unreadable-file text, and `a.call('get_design')` still shows the earlier parts. A repeat of the edit succeeds and the file is valid JSON again.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL (the refused-edit tests see success, because the server overwrites the file).

- [ ] **Step 3: Implement in `src/server.js`.**
  - `stamp()` uses `fs.statSync` and returns `` `${mtimeMs}:${size}` ``.
  - `guardExternal()`: if `stamp()` is `null` or equals `seen`, return. Otherwise call `reloadFromDisk()`. On `true`, throw the counted message (parts and wires of the reloaded design); on `false`, set `seen` to the current stamp (so a repeat goes through) and throw the unreadable-file message.
  - Set `seen = stamp()` after the initial `load()`, at the end of `persist()`, and inside `reloadFromDisk()`.
  - Call `guardExternal()` at the very start of `mutate()`, `undo()` and `redo()`.
  - The watcher keeps its 1.5 s own-write skip, then calls `reloadFromDisk()` and logs `reloaded design from disk` on success. Clearing the history on an external reload is a deliberate change from today's behaviour: an undo would otherwise restore a design that no longer exists.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all pass. Run `node --test test/session.test.js` three times in a row to confirm the timing-sensitive tests are stable.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/session.test.js
git commit -m "Refuse edits when another process changed the design file"
```

---

### Task 4: Document it

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `site/index.html` (only if it describes the shared file)

**Interfaces:**
- Consumes: the behaviour from Tasks 1 to 3.
- Produces: nothing code depends on.

- [ ] **Step 1: Update `README.md`.** Change the `BREADBOARD_DESIGN` row: the default is now `~/.breadboard-bench/sessions/<session id>.json` for Claude Code sessions and `~/.breadboard-bench/design.json` for Claude Desktop; a new session starts empty; use `open_design` for older work. Add a short note on the conflict message and that the edit is refused, not merged. Remove the sentence saying Claude Code and Claude Desktop share the file, or reword it to say they only share it when pointed at the same file.

- [ ] **Step 2: Update `CLAUDE.md`.** In the `src/server.js` layout bullet, replace the "Saves to `~/.breadboard-bench/design.json`…" text with the new file choice order and `guardExternal()`. Add `designPathFor`/`designLabel` to the `src/designs.js` bullet. Add `test/session.test.js` and `test/helpers/mcp.js` to the test list. Add "Cleanup of old session files" and "A design switcher in the viewer" to the ideas list.

- [ ] **Step 3: Check the site.** Run `grep -n "design.json\|shared\|share" site/index.html`. If it describes the shared file or sessions sharing a design, update it to match the README; otherwise leave it.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md site/index.html
git commit -m "Document per-session designs and conflict protection"
```
