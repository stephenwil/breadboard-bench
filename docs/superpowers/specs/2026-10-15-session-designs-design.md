# A design per session, with conflict protection

Status: draft for review. Date: 2026-10-15.

## Problem

Every Claude session starts its own Breadboard Bench server, and all of them read and write one file, `~/.breadboard-bench/design.json`. With several sessions open:

- They edit the same design, so one session's work lands on another session's board.
- Each server reloads the file when it changes, but it ignores changes for 1.5 s after its own last write. An edit by another server in that window is missed, and the next write from this server overwrites it without a warning.
- Undo history is per server and in memory, so a session cannot undo what another session did.

## Goal

Sessions that are working on different circuits should not see or overwrite each other's designs. When two servers do share a file, an overwrite should be refused with a clear message, never silent.

## Decisions (from the discussion)

- A new Claude Code session starts with an **empty design**. Older work comes in with `open_design` from the named designs.
- A resumed session keeps its own design. The session id is the same before and after a restart; this was checked against this session.
- Claude Desktop has no session id, so it keeps using the shared default file.
- A conflict is **refused, not merged**.

## Part 1: a design file per session

### Which file a server uses

In this order:

1. `BREADBOARD_DESIGN`, when set. Unchanged, including the use for tests and for deliberately sharing a file.
2. `~/.breadboard-bench/sessions/<CLAUDE_CODE_SESSION_ID>.json`, when the environment variable is set and contains only letters, digits, `-` and `_`.
3. `~/.breadboard-bench/design.json`, otherwise. Claude Desktop, and Claude Code older than the session-id variable, land here.

The session file is created on the first edit, not at start-up, so a session that never touches the board leaves nothing behind. The folder is created on that first write.

The old shared `design.json` is left alone. The legacy `~/.breadboard-mcp/design.json` fallback applies only to choice 3, as now.

### Naming and visibility

- A function `designPathFor(env, home)` in `src/designs.js` returns `{ file, kind }` where `kind` is `override`, `session` or `shared`. It is pure, so the order above is unit-tested without starting a server.
- A function `designLabel(file, kind)` returns the short label shown to people: `session <first 8 characters of the id>` for a session file, otherwise the file's base name.
- `get_viewer_url` and the "viewer at" line add `Design file: <label>`, so Claude and the user can tell which design a session is working on.
- The viewer header shows the label next to the design name. It comes from the `/api/state` payload as a new `file` field, added in `server.js` (not in `buildView()`, which knows nothing about files).

### Not included

- Cleanup of old session files. A later idea: list them, delete those older than N days.
- A design switcher in the viewer.

## Part 3: conflict protection

Even with a file per session, two servers can still share one: Claude Desktop beside Claude Code, a session resumed in two places, or two sessions both given the same `BREADBOARD_DESIGN`.

### The check

The server remembers the file's modification time and size as `seen` after every load, reload and write. A function `guardExternal()` runs at the start of `mutate()`, `undo()` and `redo()`, before any change:

- If the file does not exist, or its time and size equal `seen`, continue.
- Otherwise another process changed it. The server reloads the file (as the existing watcher would, including the viewer broadcast and updating `seen`) and throws a `ModelError`:
  `Another session changed this design (now N parts, M wires). Check it with get_design and repeat your edit.`
- The undo and redo stacks are cleared on this reload, since they describe a design that no longer exists.

The edit is refused whole, so nothing is overwritten and the design is unchanged by the failed call. A repeat call then works. The same message reaches the browser as a toast through `/api/op`, because `ModelError` text goes to users verbatim.

### Why refuse instead of merge

Two sessions' wiring edits can touch the same strips and holes. A merge could silently produce a design neither session intended. A refusal costs one repeated call.

### The existing watcher

The file watcher stays and still reloads quickly in the normal case. The guard closes its blind window: an external write within 1.5 s of this server's own write is caught at the next edit.

### Edge cases

- A file deleted by someone else: no conflict. The next write recreates it.
- A file that is half-written or invalid when the guard reads it: the existing "keep the current design" behaviour applies, and the edit is refused with the same message but without counts.
- The server's own write sets `seen`, so its own saves never look like conflicts.

## Files touched

- `src/designs.js`: `designPathFor`, `designLabel`.
- `src/server.js`: use them for `DESIGN_PATH`, track `seen`, add `guardExternal()`, call it from `mutate`/`undo`/`redo`, add `file` to the state payload and the `get_viewer_url` text.
- `public/index.html`: show the label in the header.
- `test/designs.test.js`: file-choice and label tests.
- `test/`: a conflict test that starts two server processes on one temp file over real MCP and checks the refusal and the repeat.
- `README.md`, `CLAUDE.md`: document the file choice, the label and the conflict message.

## Testing

- Unit: `designPathFor` for each of the three outcomes and for an unsafe session id (falls back to shared); `designLabel` for session, shared and override files.
- Integration: two servers on one temp file. Server A edits, server B tries to edit within its blind window and is refused with the message, B repeats and succeeds, and A's edit is still present. A failed edit leaves the file unchanged.
- Viewer: headless Chromium shows the label, and a toast appears for a refused browser edit.
- `npm test` stays green.

## Open assumptions

- `CLAUDE_CODE_SESSION_ID` is the stable per-session identifier. It was observed on running servers and is the same across a restart of this session.
- Other hosts that run this server (Claude Desktop) set no such variable, which is why they keep the shared file.
