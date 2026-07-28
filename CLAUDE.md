# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Core weekly cycle implemented and manually verified end-to-end in a real Telegram group: group
auto-discovery, personal menu, submission + public announcement, lock, and random draw all work.
Per-group schedule configuration (admin-only menu to customize reminder/lock/draw days and times)
is also implemented and has been exercised live in a real group. Weekly draw history is persisted to
SQLite, and submissions/lock/pending-state are now per-chat so one bot instance can safely serve
multiple independent groups (see "Multi-group isolation" below) — this multi-group path is
implemented and type-checks/unit-tested manually via a throwaway script, but not yet exercised live
against two real simultaneous groups. Submissions and the per-chat lock flag are also now persisted
to SQLite (`data/state.db`) instead of living only in process memory, so a crash or redeploy mid-week
no longer silently loses that week's data or un-locks a chat that had already closed — verified with a
manual restart-simulation script, not yet exercised against a real crash mid-cycle. Access to another
group's submit/list flow now requires actual membership in that group (`commands/access.ts`), places
are capped at 200 characters, must be a link from one of a small allow-list of providers
(`isValidPlaceLink` in `services/submissionService.ts` — see "Submission + public announcement"
below), and repeated changes are rate-limited (10s per user per chat) to keep one user from flooding
the group chat. The scheduler's reminder/lock/draw checks are `>=` with a
persisted "already fired today" guard (`storage/firedEvents.ts`) instead of an exact-minute `===`, so
a stalled event loop or a process that was down at the exact scheduled minute still catches up on the
next tick rather than silently skipping that day's action. `storage/jsonFile.ts` makes
`groupChats.json`/`groupSchedules.json` writes atomic (temp file + rename) and logs read/parse
failures instead of silently returning empty state; `bot.catch(...)` in `bot.ts` and a handful of
targeted `console.warn`/`console.error` calls (see "Architecture") are the first logging this codebase
has had. An automated test suite now covers `services/` and `storage/` plus a handful of `commands/`
handlers (see "Automated tests" below) — beyond that, verification is still manual testing via
Telegram plus the temporary debug hooks described below. A group's weekly cycle can now be paused and
resumed by that group's admin from the `/schedule` panel (`storage/pauseState.ts`, see "Pausing a
group" below) — unit-tested, not yet exercised live in a real group.

## Commands

- `npm install` — install dependencies
- `npm run dev` — run the bot with hot reload (`tsx watch src/bot.ts`)
- `npm run build` — type-check and compile to `dist/`
- `npm start` — run the compiled bot (`dist/bot.js`)
- `npm test` — run the automated test suite (see "Automated tests")

Requires a `.env` file with `BOT_TOKEN` set (see `.env.example`) — get a token from
[@BotFather](https://t.me/BotFather).

## Automated tests

`node:test` + `node:assert`, run via `tsx --test --test-force-exit 'src/**/*.test.ts'` — no new
dependency, since Node >= 22.5 (already required for `node:sqlite`) ships both built in, matching this
project's existing preference for the platform-provided option over a third-party package (same
reasoning as `node:sqlite` over `better-sqlite3`). `--test-force-exit` is required, not cosmetic: some
production code paths (e.g. `menuMessage.ts`'s 48h menu-card cleanup) schedule long-lived
non-`unref`'d `setTimeout`s, which would otherwise keep the test process hanging long after every test
finished.

Tests live next to the code they cover (`foo.ts` → `foo.test.ts`), not typechecked/emitted
separately from the rest of `src/` — `npm run build`'s `tsc` covers them too (harmless extra
`*.test.js` files end up in `dist/`, never imported by `bot.js`).

Coverage is `services/` and `storage/` (the business logic and persistence, the cheapest to test in
isolation) plus a handful of `commands/` handlers where a recent bug was security-relevant enough to
be worth a regression test directly at that layer: the `isChatMember` membership gate on
`showPersonalMenu`/`handleSubmitAction`/`showSubmissionsList`, `text.ts`'s too-long/invalid-format/
rate-limited handling, and — following the same reasoning — `schedule.ts`'s per-action admin re-verification, now
also exercised for the `pause`/`resume` actions added alongside the rest (`sched:pause`/`sched:reset`
independence is asserted directly: resetting a schedule to default must not silently un-pause the
group). Full `commands/` coverage was deliberately not attempted — a Telegraf `Context` is large,
and most handlers would need a hand-rolled fake for every property they touch; the tests that exist
build a minimal fake `ctx` object per test rather than a shared mock library, since each handler only
touches a few properties and a shared fake would either be incomplete or grow to mirror `Context`
itself.

Test isolation for storage backed by a fixed file path is env-var-driven, checked at each module's
top-level (so it must be set *before* that module is first imported):
- `storage/db.ts` (submissions + lock + pause + fired-events) and `storage/history.ts` each read
  `DEZHEREMO_STATE_DB`/`DEZHEREMO_HISTORY_DB` and fall back to the real `data/*.db` path if unset. Test
  files rely on `:memory:` being safe to share as a literal across every test file, since
  `node:sqlite`'s in-memory databases are process-local — no two test files can collide on it even
  with the same value, so this is set once, globally, in the `test` npm script.
- `storage/groupChats.ts`/`storage/groupSchedules.ts` read `DEZHEREMO_DATA_DIR` the same way, but
  *can't* share a single global value the way `:memory:` works for SQLite — two test files pointed at
  the same real directory would race on the same `groupChats.json`. Their test files instead each
  `fs.mkdtempSync` their own temp directory and set the env var themselves, then `await import(...)`
  the module *after* that (a dynamic import, not a static one — static imports are hoisted above any
  code in the file, which would set the env var too late for the module's one-time top-level `load()`).
- `storage/jsonFile.ts` needed no such override — its functions take a file path as an argument, so
  its tests just pass a temp path directly.

One easy-to-miss gotcha: `node:assert/strict`'s `deepEqual` is an alias for `deepStrictEqual`, which
also compares prototypes — `node:sqlite` rows come back as null-prototype objects, so comparing one
directly against a plain object literal fails even when every field matches. Spread the row into a
plain object first (`{ ...row }`) before asserting equality against a literal.

## What this bot does

DeZheremoBot is a Telegram bot for a group chat that helps a group of friends decide where to eat
(typically breakfast/brunch). During the week, members submit candidate places; after a deadline, the
bot randomly picks one submission and announces it in the chat. ("DeZheremoBot" is from Ukrainian slang
roughly meaning "where are we going to eat?")

## Tech stack

- **Language/runtime**: Node.js with TypeScript, ESM (`"type": "module"`, `NodeNext` resolution —
  relative imports need explicit `.js` extensions even in `.ts` source).
- **Bot framework**: [Telegraf](https://telegraf.js.org/) for the Telegram Bot API.
- **Scheduling**: `node-cron` (v4, ships its own types — don't install `@types/node-cron`, it targets
  an older incompatible API).
- **Storage**: `data/groupChats.json` and `data/groupSchedules.json` are small lookup tables read
  whole on every access, since losing track of which chats to post to (or a group's custom schedule)
  would be a real regression, not just an inconvenience. Both go through `storage/jsonFile.ts`'s
  `readJsonFile`/`writeJsonFileAtomic`: reads log (`console.error`) anything other than the file not
  existing yet (a fresh install, not a failure), and writes go to a temp file in the same directory
  then `fs.renameSync` over the target, since a plain `writeFileSync` can leave a half-written,
  unparseable file behind if the process dies mid-write — a rename on the same filesystem is atomic,
  so the target file is always either the old complete version or the new complete version, never a
  partial one. Weekly draw history is persisted separately
  in `data/history.db` via Node's built-in `node:sqlite` (`storage/history.ts`) — no external DB
  dependency (no `better-sqlite3`, no server to run); this requires Node >= 22.5.0 (`engines` in
  `package.json`), which is why `@types/node` is pinned to a v22+ major instead of the LTS-at-the-time
  v20. This week's live cycle state — submissions, the per-chat lock flag, and now the per-chat pause
  flag — is also SQLite now (`data/state.db`, `storage/store.ts`/`storage/lockState.ts`/
  `storage/pauseState.ts` via a shared connection in `storage/db.ts`), so a crash or redeploy mid-week
  no longer silently loses that week's submissions or un-does an already-fired lock (see "Multi-group
  isolation" and the `state.db` note under "Known future directions" for why this used to be in-memory
  and isn't anymore). The pause flag deliberately lives here (`chat_pauses`, alongside `chat_locks`)
  rather than in `groupSchedules.json`: that file's `resetGroupSchedule` deletes the whole per-chat
  override row wholesale (the "↩️ Скинути на дефолт" button), and a pause flag stored there would be
  silently cleared as a side effect of resetting the reminder/deadline config — pausing and schedule
  config are independent, so they live in independent storage (see "Pausing a group" below). Purely in-flight
  UI state that's cheap to lose and easy for a user to re-trigger — which private-chat message is
  currently "awaiting" a place, which message-card to edit next, which step of the `/schedule` wizard
  a user is on — deliberately stays in-memory (`pendingState.ts`, `menuMessages.ts`,
  `scheduleEditState.ts`, `scheduleMenuMessages.ts`): persisting those would add real complexity for
  state a user recovers from just by pressing the button again.

  Unlike the JSON files above, history is meant to grow and be queried (which place wins most, who
  submits most), which is why it's SQL/SQLite rather than a third JSON blob — `groupChats.json`/
  `groupSchedules.json` are small lookup tables, history is an append-only log, and `state.db` is
  small mutable current-state rows (one per active submission/lock) rather than either of those
  shapes — SQLite fits all three better than hand-rolling a fourth JSON-with-atomic-write scheme.

## Architecture

```
bot.ts                entry point — wires handlers, starts the bot, starts the cron scheduler
scheduler.ts           per-minute node-cron tick, checks each group's own schedule — not Telegram-update-triggered
telegramBroadcast.ts   broadcast() (every known group chat) and sendToChat() (one chat) — both self-heal on 403
commands/               thin Telegraf handlers; delegate logic to services/ (no business rules here)
                        includes schedule.ts, the admin-only private schedule-editor menu flow
services/               business logic: lock check, random pick, weekly reset, schedule validation — no Telegraf types
storage/                data access: in-memory Maps for ephemeral UI state (pendingState, menuMessages,
                        scheduleEditState, scheduleMenuMessages), plus data/groupChats.json (which
                        group chats the bot is in), data/groupSchedules.json (each group's custom
                        schedule), data/history.db (SQLite, append-only log of past draws), and
                        data/state.db (SQLite: this week's live submissions + lock flag + pause flag,
                        plus fired_events tracking which scheduled actions already ran today — see below)
```

There was no logging anywhere in this codebase until it became a real diagnosability problem —
`bot.ts` now registers `bot.catch((err, ctx) => console.error(...))` as a blanket safety net for any
otherwise-unhandled error from a command/action handler, and the handful of catch blocks that used to
swallow a real (not-designed-for) failure silently now log it: `telegramBroadcast.ts`'s `sendAndTrack`
for any `sendMessage` failure that isn't the expected 403, and the `commands/menuMessage.ts`/
`commands/schedule.ts` edit-fails-so-fall-back-to-a-fresh-message paths. Deliberately *not* added to
every catch block: the ones already documented elsewhere as intentional, expected control flow (a
stale callback query's 400 in `safeAnswerCbQuery`, `isChatMember`/`isGroupAdmin` treating a lookup
failure as "not a member/admin" while scanning every group) stay silent, since logging those would
just be per-request noise, not a signal of anything wrong.

Keep this layering strict: `commands/` should not contain business logic, and `services/` should not
know about Telegraf types — it should depend only on `storage/`'s interface.

## Core behavior to preserve

UI is inline buttons only for the day-to-day flow — `/start` is used purely as the group-menu
bootstrap and the private-chat deep-link entry point. The one exception is `/schedule` (see "Per-group
schedule configuration" below), a real slash command, because it has no chat context to deep-link from
(it's typed directly in a private chat with the bot, not through a group button). Submitting or
changing a place always happens in a **private chat** with the bot (never in the group), so one user's
in-progress input never spams the group or affects anyone else's chat.

**Group chat auto-discovery.** The bot doesn't need a hardcoded chat ID. `bot.on('my_chat_member', ...)`
(`commands/groupChat.ts`) fires whenever the bot's membership changes in any chat — filtered to
`'group'|'supergroup'` only (the same event also fires for private-chat block/unblock, which must be
ignored). On join it calls `addGroupChat`, on leave/kick `removeGroupChat`
(`storage/groupChats.ts`, persisted to `data/groupChats.json` so a restart doesn't lose it).
`telegramBroadcast.ts`'s `broadcast()` also self-heals: a `403` from `sendMessage` means the bot is no
longer in that chat, so it removes it from the registry even if the `my_chat_member` event was missed.

**Weekly cycle**, driven by `scheduler.ts` — a single `node-cron` job on `* * * * *` (`Europe/Kyiv`),
started via `bot.launch(() => startScheduler(bot))` — must be the `onLaunch` callback, not code placed
after `bot.launch()`, because `botInfo` isn't guaranteed populated until then. The `timezone` cron
option is meaningless for a job that fires every minute anyway, so the tick instead computes the
current Kyiv weekday/`HH:MM`/date itself via `Intl.DateTimeFormat(..., { timeZone: 'Europe/Kyiv' })`
(`getKyivNow()`), independent of the server's own timezone — the date comes from a separate `en-CA`
formatter, which happens to format as `YYYY-MM-DD` by default. Every minute, for every registered
group chat, it compares that Kyiv time against *that chat's own* `GroupScheduleConfig`
(`storage/groupSchedules.ts` — see "Per-group schedule configuration" below) and fires per chat via
`sendToChat()` rather than broadcasting the same message to every chat, since each chat's schedule can
now differ. Each condition is `time >= scheduledTime && !hasFiredToday(chatId, action, date)`, not an
exact `===` match: comparing the tick to a single point in time meant a stalled event loop or a
process that happened to be down at that exact minute would skip the action for the entire day, with
no way to notice or recover — comparing "has the scheduled time passed today, and haven't we already
done this" instead means the very next tick after any delay (or the first tick after a restart) still
catches it. `hasFiredToday`/`markFired` (`storage/firedEvents.ts`, a `fired_events(chat_id, action,
fired_date)` table in the same `data/state.db` as submissions/lock — see "Storage" under "Tech stack")
is what makes the `>=` safe: without it, every tick for the rest of the day after the scheduled time
would re-fire the action. It's persisted, not in-memory, specifically so a restart *after* an action
already fired today doesn't re-fire it (a stray duplicate reminder is harmless, but a duplicate draw
would re-announce a winner from an already-emptied submissions table) — the one accepted tradeoff is
that a bot restarted mid-day, after being down past a scheduled time, fires that action immediately on
its first tick back, which is the intended recovery, not a bug.
- `reminderWeekdays` + `reminderTime` — reminder + `buildGroupMenu` sent to that chat; each
  reminder message is auto-deleted 24h later (`sendToChat()`'s `deleteAfterMs` param in
  `telegramBroadcast.ts`, via `setTimeout` — in-memory only, so a restart within that 24h window loses
  the pending deletion and the message just stays). The winner announcement is not deleted — that one's
  meant to stick around.
- `deadlineWeekday` + `lockTime` — `lockSubmissions(chatId)`: a safety buffer before the draw.
- `deadlineWeekday` + `drawTime` — `pickWeeklyWinner(chatId)`, record history, `resetWeek(chatId)`
  (clears that chat's submissions + unlocks it), *then* announce the pick (or "nobody submitted") to
  that chat — no in-memory history is kept between weeks, by design (the persisted `weekly_draws`/
  `submissions_history` tables below are the history). `resetWeek` runs synchronously right after
  `recordDraw`, before the `sendToChat` network call, deliberately not chained off its promise: an
  earlier version awaited the send and only called `resetWeek` in `.then()`, which meant a crash
  during that network round-trip left the chat stuck locked — `fired_events` already had 'draw' marked
  fired for the day (see below), so nothing would retry the reset until the *following* week's draw.
  Unlocking/clearing is durable local state; the group announcement is best-effort UI feedback and can
  safely fail independently of it. `debug.ts`'s `/testdraw` mirrors the same ordering for the same
  reason.

A per-minute tick was chosen over one dynamically-managed `cron.schedule(...)` job per chat per event,
because adding/removing `ScheduledTask` objects every time a group edits its schedule is far more
complex than just comparing time on a shared tick. Submissions/lock/pending-state (`store.ts`,
`lockState.ts`, `pendingState.ts`) are per-chat, same as the schedule — one group's deadline, lock, or
draw never touches another group's — so a single bot instance can serve many independent groups at
once (see "Multi-group isolation" below for how each storage layer got there).

**Multi-group isolation.** Every piece of state that used to be a bare `userId`-keyed global is now
keyed by `(chatId, userId)` (or just `chatId` for the lock), because a user can be a member of more
than one group running this same bot instance, and each group's cycle must stay fully independent:
- `store.ts`: a `submissions` table in `data/state.db` with `PRIMARY KEY (chat_id, user_id)` (was
  originally `Map<chatId, Map<userId, Submission>>`, then moved to SQLite for persistence — see
  "Known future directions"'s `state.db` note — but the per-chat keying goes back to this refactor).
- `lockState.ts`: a `chat_locks` table keyed on `chat_id` — a row's presence means locked (was
  originally `Set<chatId>`, same persistence move as `store.ts`).
- `pendingState.ts`: `Map<userId, chatId>` — tracks *which group's* prompt the user is currently
  answering, not just whether they're awaiting one.
- The "➕ Додати"/"📋 Список" buttons (`commands/keyboard.ts`) deep-link `?start=add_<chatId>` /
  `?start=list_<chatId>` (`START_ADD_PREFIX`/`START_LIST_PREFIX`) — `bot.ts`'s `bot.start()` parses the
  chat id back out of the payload before calling `showPersonalMenu`/`showSubmissionsList`. (The schedule
  flow used to mirror this with a `schedule_<chatId>` payload, but it's now the `/schedule` command
  described under "Per-group schedule configuration" — it scans all groups for admin status instead of
  being told which chat via a deep link.)
- `storage/menuMessages.ts` gained a `groupChatId` field alongside the tracked private-message
  location: the callback button (`SUBMIT_ACTION`) fires with no chat context of its own (it's pressed
  inside the private chat), so `handleSubmitAction` recovers "which group is this menu for right now"
  from `getMenuMessage(userId)?.groupChatId` rather than needing it passed in. This also means
  switching context — tapping "Додати" for a different group while the private menu card is still
  open — simply re-points the same card at the new group (matching the existing one-card-per-user
  design, see below), rather than creating a second message.
- `history.ts`'s schema already had `chat_id` on every row before this refactor, so it needed no
  changes.

Because one shared menu card in the private chat can now represent different groups over time (see
above), every message it shows — the menu, the "type a place" prompt, the locked notice, and
`/start list_<chatId>`'s output — is prefixed with `📍 <group title>` (`withGroupLabel` in
`commands/menuMessage.ts`) so switching context between groups is never ambiguous. The title comes
from `storage/groupChats.ts`, which now stores `Map<chatId, title>` instead of a bare `Set<chatId>`
(persisted as `{chatId: title}` in `groupChats.json`, not an array) — captured from `ctx.chat.title`
when `my_chat_member` fires on join (`commands/groupChat.ts`), opportunistically backfilled the same
way if anyone runs `/start` directly in the group (`bot.ts`), which also covers groups registered
before this field existed (`groupChats.ts`'s `load()` migrates the old bare-array format to titles of
`''`, i.e. "unknown until backfilled" — `getGroupChatTitle` treats an empty title as absent, so the
label is just omitted rather than showing a blank `📍`), and kept fresh afterwards by
`handleNewChatTitle` (`commands/groupChat.ts`, `bot.on('new_chat_title', ...)`) — without it, a group
renamed after the bot joined would show the stale original title in every private-chat label forever,
since nothing else re-reads `ctx.chat.title`.

**Personal menu** (`commands/menu.ts`, shown after a group's "➕ Додати" url-button deep-links into
`/start add_<chatId>`): renders one of three states from `getUserSubmission`/`isSubmissionLocked` —
locked (no button), has a submission (shows it + "✏️ Змінити"), or none yet ("➕ Додати") — both
buttons share one `callback_data: SUBMIT_ACTION` handler (`handleSubmitAction`), which looks up the
group from the tracked menu message (see "Multi-group isolation"), re-checks that group's lock, then
delegates to the existing `promptForPlace` (`commands/add.ts`) to mark the user "awaiting" for that
group and ask for text.

Because the deep-link `chatId` (and, for `handleSubmitAction`, the `chatId` recovered from the tracked
menu message) is attacker-controlled input from a private chat with no group context of its own, both
`showPersonalMenu` and `handleSubmitAction` call `isChatMember` (`commands/access.ts`, a thin wrapper
around `ctx.telegram.getChatMember` treating `'left'`/`'kicked'`/a lookup failure as "not a member")
before doing anything else — without it, anyone who learns another group's `chatId` (chat ids aren't
secret: they leak through forwarded messages, API responses, etc.) could submit into or list a group
they were never in. It's checked at both entry points, not just once, for the same reason the schedule
flow re-checks admin status twice: membership can change between opening the menu and pressing the
button.

**Menu message is edited in place, not resent** (`commands/menuMessage.ts`): every "state change" in the
private chat — pressing "✏️ Змінити"/"➕ Додати", the resulting prompt, the "🔒 Прийом заявок закритий"
notice shown by both `showPersonalMenu` and `handleSubmitAction` when the chat is locked, and the
confirmation after submitting — reuses and edits the *same* Telegram message (`ctx.telegram.editMessageText`)
instead of sending a new one each time. This was a deliberate fix for a real problem hit during manual testing: the
group's "➕ Додати" keeps deep-linking into the same menu message, so repeated edits from one user used to
pile up into a long, ever-growing wall of separate bot messages in their private chat. (The locked notice
was the one holdout still using a bare `ctx.reply` — an extra stray message next to the tracked card
instead of updating it; both `showPersonalMenu` and `handleSubmitAction` now route it through
`updateMenuMessage` like everything else.) The message being
edited is tracked per-user in `storage/menuMessages.ts` (`userId` → `{chatId, messageId, groupChatId}`,
in-memory, lost on restart like the rest of this state). `updateMenuMessage` tries the edit first and falls back to
`sendMenuMessage` (a fresh message, re-tracked) if it throws — the expected reason being Telegram's own
~48h cap on editing a bot message, not a bug, so this is a real external boundary and deliberately the one
place in this codebase that swallows a Telegram API error. That same 48h figure is reused as
`MENU_MESSAGE_TTL_MS`: each tracked menu message schedules its own `setTimeout` to delete itself once it
ages past the point Telegram would refuse to edit it anyway, so a stale, no-longer-interactive card
doesn't just sit in the chat forever — same `deleteAfterMs`-via-`setTimeout` pattern as the reminder
auto-delete in `telegramBroadcast.ts`, and with the same restart caveat (a restart within that window
loses the pending deletion, and the message just stays).

**List**: the group's "📋 Список" button is a url-button deep-link into `/start list_<chatId>` (same
mechanism as "➕ Додати" → `/start add_<chatId>`), handled in `bot.ts`'s `bot.start()` by branching on
`ctx.startPayload`'s prefix (`START_LIST_PREFIX` vs `START_ADD_PREFIX`, `commands/keyboard.ts`) into
`showSubmissionsList(ctx, chatId)` (`commands/list.ts`), which replies in the private chat that was just
opened, scoped to that group's submissions — gated by the same `isChatMember` check described under
"Personal menu" above, for the same reason (the `chatId` is untrusted deep-link input). This is deliberate, not a
workaround: Telegram's Bot API has no way to send a group-triggered reply visible to only one member, and
deep-linking through `/start` is the documented, standard pattern for that — a callback button that DMs
the clicker directly was tried and rejected, since it 403s for any user who hasn't opened a private chat
with the bot yet. The visible chat bubble renders as a bare `/start` with no payload shown — that's
normal Telegram client rendering for deep links, not a bug, and happens for every bot that uses this
mechanism.

**Per-group schedule configuration** (`commands/schedule.ts`, `services/scheduleService.ts`,
`storage/groupSchedules.ts`): unlike add/list, there's no group button for this — an admin types
`/schedule` directly in a **private chat** with the bot (`bot.command('schedule', handleScheduleCommand)`
in `bot.ts`; typing it in a group instead just gets a reply telling them to DM the bot). Because that
private chat has no chat-id context of its own, `handleScheduleCommand` calls
`ctx.telegram.getChatMember(chatId, userId)` against *every* chat in `listGroupChats()`
(`storage/groupChats.ts`) to find which groups this user administers (`'creator'`/`'administrator'`
status) — a lookup failure for any one chat (bot no longer a member, API hiccup) is treated as "not
admin there" rather than aborting the whole scan. Zero admin groups → told so; exactly one → the
schedule summary opens immediately for that group; more than one (the multi-group-admin case) → an
inline keyboard lists each group by title (`sched:select:<chatId>`, `commands/keyboard.ts`'s
`getGroupChatTitle`) for the admin to pick, and picking one re-verifies admin status for that specific
chat before reusing the same edit-in-place message to show the summary. That re-check isn't limited to
`select`: `handleScheduleAction` re-verifies admin status for *every* action that targets a group —
`edit_reminder`/`edit_deadline`/`reset` via the chatId embedded in that button's `callback_data`, and
`day`/`days_done`/`back` via the chatId in the user's tracked wizard state — and `handleScheduleTextStep`
does the same before applying a typed time. This isn't just "membership could change between opening
the menu and pressing a button" (per-request paranoia): Telegram never expires a message's inline
buttons, so the summary panel's "✏️ Дні та час нагадувань"/"↩️ Скинути на дефолт" buttons stay pressable
indefinitely — without a check on every action, someone demoted from admin after they last opened
`/schedule` (even days earlier) could still silently rewrite that group's schedule from that old
message. A group that never has its schedule touched this way keeps exactly the original hardcoded
schedule (`DEFAULT_SCHEDULE` in `groupSchedules.ts`: Mon/Wed/Fri 10:00 reminder, Fri 18:00 lock, Fri
18:15 draw) — `getGroupSchedule` falls back to it when no override is persisted.

`scheduleService.ts`'s `updateReminderSchedule`/`updateDeadlineSchedule` also reject (`reason:
'reminder_after_lock'`) any combination where a reminder weekday coincides with `deadlineWeekday` at or
after `lockTime` — otherwise a misconfigured schedule could tell people to "add a place" on a group
message sent out *after* that day's submissions already closed. This is checked from both sides
(editing the reminder can create the conflict against an existing deadline, and editing the deadline
can create it against an existing reminder), since either edit alone can introduce it.

Editing is a small multi-step wizard (weekday multi-toggle → time entry for the reminder days; weekday
single-select → lock time → draw time for the deadline), tracked per-user in
`storage/scheduleEditState.ts` as a discriminated union of `{flow, step, ...}`. It reuses the same
edit-in-place message pattern as the personal menu (`sendSchedulePanel`/`updateSchedulePanel` mirror
`sendMenuMessage`/`updateMenuMessage`), but needs its own tracked-message slot
(`storage/scheduleMenuMessages.ts`) rather than sharing `menuMessages.ts`, since a user could plausibly
have both the add/list menu and the schedule panel open at once.

`commands/text.ts` checks `handleScheduleTextStep` before the submission flow's own awaiting-state
check (see "Submission + public announcement" below), so a wizard state that's still set counts as
"this text is a schedule reply" no matter what the user actually meant it for. Every
`setScheduleEditState` call in `commands/schedule.ts` therefore goes through
`setScheduleEditStateWithTTL` instead (10 minutes, `SCHEDULE_EDIT_TTL_MS`), which schedules a
`setTimeout` clearing that user's state unless it's been superseded by then (same by-reference-identity
guard as `trackMenuMessage`/`trackSchedulePanel`'s message-id check). Without it, an admin who starts
`/schedule`, gets to a time-entry step, and then abandons the wizard without pressing "⬅️ Скасувати"
or finishing it would have every later text message they send — including an attempt to submit a
place — silently swallowed as an "invalid time format" reply to the stale wizard, with no visible
symptom beyond "typing a place does nothing."

One gotcha this surfaced: Telegram
rejects an edit whose text+keyboard are byte-identical to the current message ("message is not
modified") — pressing "↩️ Скинути на дефолт" when already at default used to trip that error and fall
through to sending a duplicate message, so `updateSchedulePanel` now treats that specific error as a
no-op rather than a reason to fall back to `sendSchedulePanel`. Time input (`HH:MM`, validated by
`scheduleService.ts`'s `isValidTime`) is consumed through the same global `bot.on('text', ...)` handler
as submissions — `commands/text.ts` checks `handleScheduleTextStep` first, before the
`getAwaitingChatId` check, so the two free-text flows can't collide. Callback buttons are all
prefixed `sched:` and routed through one `bot.action(/^sched:/, handleScheduleAction)`; because a
callback query can go stale between a button press and the handler running (old message, double-tap),
every `ctx.answerCbQuery()` call goes through a local `safeAnswerCbQuery` that swallows the resulting
400 instead of letting it crash the process (this was hit for real during testing and took the whole
bot down before the fix). `commands/menu.ts`'s `handleSubmitAction` (the ➕ Додати/✏️ Змінити button —
the single most-pressed callback in the bot) has its own local copy of the same guard for the same
reason: it's a separate `bot.action(...)` registration from the `sched:` ones, so it doesn't share
`schedule.ts`'s module-private helper, but an unguarded `ctx.answerCbQuery()` there would fail the
exact same way on a stale/double-tapped press — just silently no-op the button instead of crashing the
process, since `bot.catch(...)` now exists as a backstop.

**Pausing a group** (`storage/pauseState.ts`, `services/submissionService.ts`'s `isGroupPaused`/
`pauseGroup`/`resumeGroup`, wired into the `/schedule` summary panel in `commands/schedule.ts`): an
admin can pause and later resume a group's entire weekly cycle from the same summary panel used to
edit the schedule — a "⏸ Призупинити цикл"/"▶️ Відновити цикл" toggle button next to "↩️ Скинути на
дефолт", going through the exact same `sched:` action routing and per-action admin re-verification as
every other button there (see "Per-group schedule configuration" above for why every action re-checks
admin status, not just `select`). Pausing is a live-cycle flag, not a schedule setting — it's stored in
`data/state.db`'s `chat_pauses` table (mirroring `chat_locks`) rather than in `groupSchedules.json`,
specifically so it survives "↩️ Скинути на дефолт" (see the `state.db` note under "Storage" in "Tech
stack" for why mixing the two would have made resetting the schedule silently un-pause the group too).

While a group is paused, `scheduler.ts`'s per-minute tick still evaluates that chat's reminder/lock/
draw conditions and still calls `markFired` when a condition is met — it only skips the actual side
effect (`sendToChat`/`lockSubmissions`/`pickWeeklyWinner`+`recordDraw`+`resetWeek`). This is
deliberate, not an oversight: the scheduler's `>=` + `hasFiredToday` comparison exists precisely to
catch up on a missed action after a stalled process or a restart (see the weekly-cycle notes above),
and a paused chat resumed later in the same calendar day would otherwise look identical to "the
process was down at that exact minute" and fire that day's reminder/lock/draw retroactively the moment
it's resumed — which is the opposite of what pausing is for. Marking the event fired regardless means
a pause that spans a scheduled time skips that occurrence for good, not just until resumed; if a pause
spans an entire deadline day, that week's lock+draw simply doesn't happen and whatever's already
submitted carries over to the next active deadline instead of being drawn on a stale, incomplete week.
`submitPlace` (`services/submissionService.ts`) also rejects new submissions while paused
(`reason: 'paused'`), checked ahead of the lock check since pause and lock are independent flags — a
paused group is not automatically locked, so without this check submissions would otherwise go through
as normal while paused, silently queueing for whichever future week the group happens to resume into.
`commands/menu.ts`'s `showPersonalMenu`/`handleSubmitAction` and `commands/text.ts` all show a distinct
"⏸ Цикл цього тижня призупинено" message rather than the "🔒 закритий" lock text, so a paused group
never looks to a member like it's merely mid-week-locked. The temporary `/testlock`/`/testdraw` debug
commands (`src/debug.ts`) intentionally do not check the pause flag — they bypass the scheduler
entirely by design (see "Temporary debug scaffolding" below) and are meant to be deleted before real
use, so teaching them about pause wasn't worth the churn.

**Submission + public announcement**: the user's next plain-text message in the private chat is caught
by the global `bot.on('text', ...)` handler (`commands/text.ts`) — acts only if that user has a pending
group recorded in `storage/pendingState.ts` (`getAwaitingChatId`, `Map<userId, chatId>` — which group's
prompt they're answering, not just whether they're awaiting one). `submitPlace(chatId, userId, ...)`
(`services/submissionService.ts`) is the load-bearing lock check — not just the menu render — since a
user could be mid-flow exactly as the Friday 18:00 lock fires; it also returns the user's previous
submission for *that group* (if any) so `text.ts` can tell a fresh submission from a replacement. It
also rejects a resubmission that's an exact string match (`===`, no trim/case-fold beyond the `.trim()`
already applied in `text.ts`) of the user's current place in that group — a deliberately minimal check
against just their own submission, not a cross-user duplicate check against everyone else's. It also
enforces `MAX_PLACE_LENGTH` (200 characters) before anything else, then — before the duplicate check —
that the place is a recognized link (`isValidPlaceLink`, `reason: 'invalid_format'` otherwise): a
free-text place name is no longer accepted at all, only a link matching one of three hardcoded
provider patterns (`expz.menu/<uuid>`, `maps.app.goo.gl/<code>`, `instagram.com/<username>`, each a
regex in `PLACE_LINK_PATTERNS`) — a deliberately small, hardcoded allow-list ("поки тільки такі"),
not a generic URL check, since a bare "is this a URL" test would let through links to sites with no
reliable way to show the place. Extending it to another provider (e.g. Google Maps' plain `maps.app.goo.gl`
alternative, or a future in-house menu site) means adding one more pattern to that array. Past the
duplicate check, `submitPlace` also enforces a 10-second `RATE_LIMIT_MS` cooldown per `(chatId, userId)` (`storage/rateLimit.ts`, a `Map<"chatId:userId",
lastSubmitAtMs>`) — the rate limit sits *after* the duplicate check deliberately, so double-tapping the
same value never trips it, only rapid genuine changes do, since each of those broadcasts a fresh message
into the group chat. That map prunes entries older than an hour on every write (`recordSubmitTime`) —
well past `RATE_LIMIT_MS` itself, just bounding growth — since without it the map would hold one entry
per `(chatId, userId)` pair that ever submitted, for the lifetime of the process. `text.ts` treats `too_long`/`invalid_format`/`rate_limited` as retryable:
unlike `locked`/`duplicate`, it does not clear the user's "awaiting" state, so they can just retype
instead of pressing "✏️ Змінити" again — an `invalid_format` retry gets `PLACE_LINK_FORMAT_HINT`
(`commands/add.ts`, a message spelling out the three accepted formats with an example link each), the
same text `promptForPlace` shows up front when first asking for a place, so the "what am I supposed to
paste here" wording is identical whether the user's seeing it for the first time or after a rejected
attempt. On success
it sends (via `sendToChat`, to that one group only — not `broadcast()`, since a submission is scoped to
the group it was made for) `🍽 <username> пропонує: <place>` — or, if this overwrote a *different*
previous place, `🍽 <username> змінює варіант: <previous> → <place>` instead (private confirmation
mirrors this: `Додано: <place> ✅` vs `Замінено: <previous> → <place> ✅` — edited into the same menu
message per above). `ctx.deleteMessage()` on the user's own plain-text reply runs on every outcome —
success, locked, duplicate, too-long, invalid-format, and rate-limited alike — so it never lingers next
to the card it was submitted into. Ukrainian past-tense verbs conjugate by
gender (`обрав`/`обрала`) and the bot doesn't know anyone's gender — all announcement/menu text uses
present-tense or impersonal phrasing to avoid needing gender agreement.

Each user has at most one submission *per group* — resubmitting overwrites the previous one for that
group (an upsert on `(chat_id, user_id)` in `storage/store.ts`'s `submissions` table), so "the previous
submission" is always unambiguous within a group: there's no history to pick the wrong version of.

**Weekly draw history** (`storage/history.ts`, recorded via `recordDraw` in
`services/submissionService.ts`): every time the scheduler's draw branch fires, `scheduler.ts` calls
`recordDraw(chatId, winner)` right after `pickWeeklyWinner()` and before `resetWeek()` clears that
chat's row from `submissions` — history has to read `listSubmissions()` before that data disappears
for the week. Two tables: `weekly_draws` (one row per draw — `chat_id`, `drawn_at`, `winner_user_id`,
`winner_place`, `total_submissions`) and `submissions_history` (one row per submission that week, FK'd
to the draw, with an `is_winner` flag) — so both "what won" and "what everyone proposed that week" are
queryable later. `chat_id` was on every row from the start, ahead of the multi-group refactor described
above, so this table needed no reshaping when that landed. Deliberately **not** wired into `debug.ts`'s
`/testdraw`/`/reset` HTTP hooks — those are test-only triggers, and recording them would pollute real
history with fake data.

## Temporary debug scaffolding (`src/debug.ts`) — remove before real use

Added to manually test the weekly cycle without waiting for the actual cron schedule. Two ways to
trigger the same reminder/lock/draw/reset logic the scheduler uses:
- Telegram commands `/testreminder`, `/testlock`, `/testdraw`, `/testreset` — these mutate a
  group's shared state (force-lock, force-draw, force-reset), so they follow the exact same
  private-chat + admin-group-picker flow as `/schedule` (see "Per-group schedule configuration"):
  typed in a **private chat** with the bot (a group chat gets told to DM the bot instead),
  `findAdminGroupChats`/`isGroupAdmin` scan `listGroupChats()` for groups the caller administers
  (duplicated locally from `commands/schedule.ts` rather than shared, since this whole file is
  meant to be deleted wholesale), zero admin groups → refused, exactly one → the action runs
  against it immediately, more than one → an inline keyboard (`debug:<action>:<chatId>`,
  `commands/keyboard.ts`'s `getGroupChatTitle`) lets the admin pick which group to target, re-
  checking admin status on that specific chat before running. Without this, any member of any
  group the bot is in could force-close submissions or force an early draw for everyone — the
  original "any chat" version had no such check.
- Local-only HTTP hooks on `127.0.0.1:4321` (never exposed beyond localhost): `/reminder`, `/lock`,
  `/draw`, `/reset` — unlike the Telegram commands above, these have no calling user to check admin
  status against, so they still loop over every registered group the same way the old Telegram
  commands used to (localhost-only exposure is the only guard here). These exist because triggering
  the *real* draw logic against real test data has to happen inside the running bot process itself
  (it's the only thing with the `Telegraf` instance needed to actually send messages), hence the HTTP
  hooks instead of a detached script — this reasoning predates `state.db` and doesn't depend on where
  submissions/lock state lives.

Both are wired into `bot.ts` behind comments marked `// TEMP`. Strip `registerDebugCommands` and
`startDebugServer` (and their `bot.ts` call sites) before this bot is used for real — group members
shouldn't see test commands, and there's no reason to keep a debug server running in production.

**Gotcha that used to bite during testing, now fixed**: `tsx watch` restarts the whole process on any
source-file save. Submissions and lock state now survive that (they're in `data/state.db`, not
memory) — only the ephemeral UI state (`pendingState`, `menuMessages`, `scheduleEditState`,
`scheduleMenuMessages`) still resets on a dev-server restart, which just means re-pressing whatever
button you were on, not losing test data.

## Known future directions (not yet implemented)

Voting instead of pure random selection, a place blacklist, and admin controls (force draw, manual
reset, reopen submissions). When implementing one of these, keep the `storage/` interface stable so
these can be added without a rewrite.

(Submissions/lock persistence — previously listed here as not-yet-implemented — now lives in
`data/state.db`; see "Storage" under "Tech stack" and `storage/db.ts`.)
