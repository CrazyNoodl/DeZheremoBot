# Design: Scheduler diagnostics + admin action log viewer

Two new read-only screens under `/admin`'s "🧪 Експериментальні функції" hub, alongside the
existing "📊 Статистика": a scheduler health/DB-size diagnostic, and a viewer for the
`admin_actions` audit log that `storage/auditLog.ts` has been writing to since "Admin action
audit log" but that nothing has ever surfaced back to an admin.

Both were listed as candidates in CLAUDE.md's "Known future directions".

## Scope

- New "🩺 Діагностика планувальника" screen: last scheduler tick (wall-clock time since, stuck
  threshold), and file sizes of `data/state.db` / `data/history.db`.
- New "📜 Лог дій адмінів" screen: paginated, newest-first feed of that group's `admin_actions`
  rows (actor, action, detail, Kyiv timestamp).
- Both are pure navigation (like `select`/`blocklist`/`experimental`/`stats`) — no mutation, so
  neither writes to `admin_actions` itself.
- Both reachable only through `/admin`'s existing per-action admin re-verification, same as every
  other screen in this panel.

Out of scope: a scheduler restart/kick action, filtering the audit log by action type, parsing
`detail` into structured fields, persisting `lastTickAt` across restarts, per-chat scoping of the
diagnostics screen's content.

## Architecture

`buildExperimentalKeyboard` (`commands/admin.ts`) gains two rows:

```
[🩺 Діагностика планувальника]  -> admin:diagnostics:<chatId>
[📜 Лог дій адмінів]            -> admin:auditlog:<chatId>:0
```

Both route through the existing `bot.action(/^admin:/, handleAdminAction)` dispatcher and
`panel.update(...)` (from `commands/panel.ts`'s shared `createPanel`), exactly like every other
`/admin` sub-screen.

## Screen 1: Scheduler diagnostics

Content is **global** (one scheduler tick loop serves every chat), even though the screen is
opened via a specific group's `/admin` — confirmed as the intended behavior, not a per-chat
metric.

**Last tick.** `scheduler.ts` gains a module-level `let lastTickAt: number | null = null`, set to
`Date.now()` (real wall-clock, independent of the `now` parameter `runSchedulerTick` already takes
for simulated/tested Kyiv time) at the very start of `runSchedulerTick`. A new
`export function getLastTickAt(): number | null` exposes it. In-memory only, following this
codebase's existing convention for cheap-to-lose, easy-to-recover state (`pendingState.ts`,
`menuMessages.ts`): if `/admin` can render at all, the process is alive, so this only needs to
answer "is the per-minute tick still actually firing," not "is the process up."

**Stuck threshold:** 2 minutes since `lastTickAt` → 🔴, otherwise 🟢. If `lastTickAt` is still
`null` (fresh process, no tick yet) → a neutral "⏳ ще не було жодного тіка" line, not 🔴, so a
just-deployed bot doesn't immediately read as broken.

**DB sizes.** `storage/db.ts` and `storage/history.ts` each export a small path getter
(`getStateDbPath()` / `getHistoryDbPath()`) returning their existing private `DB_FILE` const. A new
`storage/diagnostics.ts` adds:

```ts
export interface StorageDiagnostics {
  stateDbBytes: number | null;
  historyDbBytes: number | null;
}
export function getStorageDiagnostics(): StorageDiagnostics;
export function formatBytes(bytes: number): string; // "84 KB", "1.4 MB"
```

`getStorageDiagnostics` uses `fs.statSync` on both paths inside a `try/catch`, returning `null` for
a path that doesn't exist yet or is `':memory:'` (test env) rather than throwing.

**Text** (`buildDiagnosticsText` in `admin.ts`):

```
🩺 Діагностика планувальника

Останній тік: 🟢 12 сек тому (14:32:07)
Розмір БД: state.db — 84 KB, history.db — 212 KB
```

Keyboard: just a "‹ Назад" to `admin:experimental:<chatId>`.

## Screen 2: Admin action log viewer

`storage/auditLog.ts`'s `listAdminActions(chatId)` is unchanged (still returns all rows for that
chat, oldest-first, no filtering/pagination in the storage layer). Sorting and pagination happen in
`commands/admin.ts` on the already-fetched array — the same "fetch once, filter/map in the command"
shape `buildBlocklistKeyboard` already uses for `listBlockedUsersInGroup`.

**Pagination:** page size **10**, newest-first (reverse the array, then slice). The page number
lives directly in `callback_data` (`admin:auditlog:<chatId>:<page>`) rather than in a new
in-memory selection map — there's nothing to remember between taps, unlike
`scheduleEditState`/`ratingSelectionState`, since every render is a pure function of
`(chatId, page)`. "‹ Новіші" / "Старіші ›" buttons render only when a previous/next page actually
exists; "‹ Назад" always targets `admin:experimental:<chatId>`.

**Row format:**

```
📜 Лог дій адмінів (стор. 1/3)

03.08 14:05 — @admin_name: Призупинив цикл
03.08 12:40 — @admin_name: Заблокував (target:12345)
02.08 18:15 — @admin_name: Провів розіграш (winner:67890)
```

- Timestamp: Kyiv local, `DD.MM HH:MM`, via a new `formatKyivDateTime(ms: number): string` in
  `kyivTime.ts` — the one existing place "what time is it" is computed.
- Actor: `actorName` as stored (plain text, not HTML — this screen, like the rest of `/admin`,
  doesn't set `parse_mode`), falling back to `id<actorUserId>` when `actorName` is `null`, mirroring
  `admin.ts`'s existing local `displayName` helper.
- Action label: a new `Record<AdminAction, string>` Ukrainian-label map, local to `commands/admin.ts`
  (pure presentation concern for one command file, not a storage/service concern).
- `detail`: rendered verbatim in parentheses when present (`target:12345`, `winner:67890`,
  `days:... time:...`) — no parsing into structured fields, matching how these strings were
  deliberately written as free text with no schema.

**Empty state:** if `listAdminActions(chatId)` is empty, render "Ще немає жодної дії в журналі."
instead of an empty page.

## Error handling

- `getStorageDiagnostics`: `fs.statSync` failure (missing file, `:memory:` in tests) → `null` for
  that field, not a thrown error; the text renders "н/д" for a `null` size.
- `getLastTickAt() === null`: neutral "not yet ticked" message, not treated as stuck.
- Audit log page out of range (e.g. stale button after the underlying data shrank somehow — not
  expected in practice since this log is append-only, but cheap to guard): clamp the requested page
  into `[0, lastPage]` rather than rendering an out-of-bounds slice.

## Testing

- `storage/diagnostics.test.ts`: `getStorageDiagnostics` against a real temp file and a missing
  path; `formatBytes` boundary cases (0, <1KB, exactly 1MB, etc).
- `scheduler.test.ts`: `getLastTickAt()` is `null` before any `runSchedulerTick` call, and reflects
  a real timestamp after one, independent of the simulated `now` passed in.
- `kyivTime.test.ts` (new, if it doesn't already exist as of implementation time — verify): a fixed
  `ms` timestamp formats as the expected `DD.MM HH:MM` in `Europe/Kyiv`.
- `admin.test.ts`: text/keyboard builders for both screens — diagnostics text under 🟢/🔴/⏳ states;
  audit log pagination boundaries (page 0 with <10 rows: no "Новіші"/"Старіші"; enough rows for 3
  pages: correct buttons on first/middle/last page); empty-log message. Follows this codebase's
  existing `dezheremo-testing` conventions (env var isolation via
  `DEZHEREMO_STATE_DB`/`DEZHEREMO_HISTORY_DB`, per-file chat-id numbering).
