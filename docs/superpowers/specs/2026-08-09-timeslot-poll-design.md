# Design: Time-slot availability poll (experimental)

A new experimental, per-group toggleable feature: right after a member submits a real place this
week, the bot asks — in the same private-chat card — which day(s) and, optionally, which hour(s)
they're generally free this week. This is a **general availability poll**, decoupled from *which*
place they proposed (not "when would you go to your own place suggestion"). Its aggregated result
(the single day + single hour with the most votes) is added as a lightweight suggestion line to the
winner-announcement message, so the group has a starting point for "when do we actually go" instead
of relitigating it in chat every week.

Discussed and scoped via brainstorming; see CLAUDE.md's "Known future directions" for how
experimental features generally graduate to the `/admin` hub.

## Scope

- New `GroupScheduleConfig` fields (`/schedule`-configured, like the rest of the schedule):
  `timeSlotPollWeekdays` (1–7 weekdays) and `timeSlotPollTimes` (0–5 `"HH:MM"` values).
- New enable/disable toggle, `/admin` → 🧪 Експериментальні функції (like the rating survey's
  toggle split: config in `/schedule`, on/off in `/admin`).
- New private-chat flow: day-picker → (optional) hour-picker, shown in the same tracked menu card
  right after a genuine new/changed place submission, editable later via a menu button.
- New per-user "🕐 Будь-коли" ("any day"/"any hour") option on each screen, mutually exclusive with
  specific picks, contributing +1 to every option in its dimension.
- New winner-announcement line: the single day and single hour with the most votes (tie-break:
  closest to the deadline for days, earliest for hours) — a suggestion, not a commitment.
- Blocked-user exclusion from both answering and the aggregate, symmetric to how blocking already
  removes a `submissions` row.
- Deadline-conflict validation between `deadlineWeekday` and `timeSlotPollWeekdays`, both
  directions.

Out of scope (deliberately deferred, same "experimental holding area" reasoning as other features
in "🧪 Експериментальні функції"): any persisted history of past availability answers, a
`/admin` statistics tab for this data, per-day×hour combined matrix voting, group-visible (rather
than private-chat) voting UI, re-validating already-collected answers against a later config change.

## Data model

### `GroupScheduleConfig` additions (`storage/groupSchedules.ts`)

```ts
timeSlotPollWeekdays: number[]; // 0=Sunday..6=Saturday, min 1 max 7
timeSlotPollTimes: string[];   // "HH:MM", 0 to 5 entries
```

Defaults: `timeSlotPollWeekdays: [6, 0]` (Sat/Sun), `timeSlotPollTimes: ['10:00', '10:30',
'11:00']`. Merged the same way every other `GroupScheduleConfig` field is (`getGroupSchedule`'s
spread-merge), so an existing customized schedule picks up these defaults instead of `undefined`.
Reset by "↩️ Скинути на дефолт" along with the rest of the schedule — consistent with
`ratingSurveyWeekday`/`ratingSurveyTime` already being reset the same way.

### Enabled flag: `storage/timeSlotPollState.ts`

New `state.db` table `time_slot_poll_enabled (chat_id INTEGER PRIMARY KEY)`. Presence means
**enabled** — the inverse of `ratingSurveyState.ts`'s `rating_survey_disabled`, because this
feature's default is *off* (a new experimental feature, opt-in), whereas the rating survey's
default is *on*. `isTimeSlotPollEnabled(chatId)` / `setTimeSlotPollEnabled(chatId, enabled)`.

### Responses: `storage/timeSlotResponses.ts`

New `state.db` table:

```sql
CREATE TABLE IF NOT EXISTS time_slot_responses (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  days TEXT NOT NULL,       -- comma-separated weekday numbers, e.g. "6,0"
  days_any INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL,      -- comma-separated "HH:MM", e.g. "10:00,11:00"
  times_any INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
```

One row per user per week, upserted — same shape as `submissions`. Functions: `addOrUpdateTimeSlotResponse(chatId, userId, { days, daysAny, times, timesAny })`,
`getTimeSlotResponse(chatId, userId)`, `listTimeSlotResponses(chatId)`, `clearTimeSlotResponses(chatId)`
(called from `resetWeek`), `removeTimeSlotResponse(chatId, userId)` (called from
`blockUserFromGroup`).

### In-memory wizard state: `storage/timeSlotWizardState.ts`

```ts
interface TimeSlotWizardState {
  chatId: number;
  step: 'days' | 'times';
  selectedDays: Set<number>;
  daysAny: boolean;
  selectedTimes: Set<string>;
  timesAny: boolean;
}
```

`Map<userId, TimeSlotWizardState>`, in-memory only — same category as `ratingSelectionState.ts`:
cheap to lose, and reopening the picker (via the menu's "🗓 Моя доступність" button) always
reseeds from the persisted response (or fresh/empty if none), so there's no TTL to reason about —
unlike `scheduleEditState.ts`, this flow never reads free text, so an abandoned wizard has no way to
misinterpret a later message. A stale card is protected the same way every other menu action is:
`isStaleMenuTap`.

## Admin configuration flow (`/schedule`)

New row on the `/schedule` summary panel: "🗓 Опитування про час" (`sched:timeslot:<chatId>`),
opening a sub-screen (`renderTimeSlotConfigScreen`) showing the current days/hours and two edit
buttons:

- **"✏️ Змінити дні"** (`sched:timeslot_days:<chatId>`) reuses `buildWeekdayMultiSelectKeyboard()`
  verbatim (the same widget `reminderWeekdays` editing already uses), with the same "at least 1
  selected" guard on the finalize step (mirroring `days_done`'s empty-selection guard) plus the new
  deadline-conflict check below.
- **"✏️ Змінити години"** (`sched:timeslot_times:<chatId>`): a small step-through screen listing
  current times as remove-buttons (`18:00 ✕` → `sched:timeslot_time_remove:<chatId>:<HH:MM>`),
  "➕ Додати час" (opens a one-off `HH:MM` text prompt, validated via the existing `isValidTime`;
  a 6th attempt is rejected with an alert — "вже максимум 5"), and "✅ Готово". 0 remaining times is
  valid and means the hour-picker step is skipped entirely for users answering the poll.

Both finalize steps log to `admin_actions` (`'edit_timeslot_days'` / `'edit_timeslot_times'`) only
when the change is actually applied — a rejected edit (deadline conflict, bad time format, over the
5-time cap) performs no mutation and must not log, the same rule every other `/schedule` edit
already follows.

### Deadline conflict validation (`services/scheduleService.ts`)

Because weekdays are cyclic, "must start the day after the deadline" reduces to a simple exclusion:
`timeSlotPollWeekdays` must never contain `deadlineWeekday` itself (everything else in the week —
Sat through Thu for a Friday deadline — already comes "after this week's deadline, before next
week's"). Checked from both sides, mirroring the existing `reminderWeekdays`/`deadlineWeekday`
mutual check:

- Saving `timeSlotPollWeekdays` rejects (`reason: 'timeslot_deadline_conflict'`) if the new list
  includes the chat's current `deadlineWeekday`.
- Saving a new `deadlineWeekday` (in the deadline-edit wizard) rejects with the same reason if that
  weekday is present in the chat's current `timeSlotPollWeekdays`.

## Enable/disable (`/admin` → 🧪 Експериментальні функції)

New sub-screen `admin:timeslot:<chatId>` (`renderTimeSlotPollMenu`): shows enabled/disabled state
plus a read-only echo of the current days/hours (actual editing stays in `/schedule`, same split as
the rating survey), one toggle button (`admin:timeslot_toggle:<chatId>` → `setTimeSlotPollEnabled`,
logged as `'toggle_timeslot_poll'`), and "‹ Назад" to `admin:experimental:<chatId>`.

Disabling does **not** clear this week's already-collected `time_slot_responses` — they simply stop
being read (the winner announcement omits the suggestion line whenever
`isTimeSlotPollEnabled(chatId)` is false at draw time), the same "toggle only gates the side effect"
principle the rating survey's enabled flag already follows.

## User-facing flow (private-chat card)

Triggered from `renderSubmitOutcome` (`commands/menu.ts`) immediately after a successful **new or
changed place submission** — never for a decline, and never if the user already has a
`time_slot_responses` row for this chat this week (so resubmitting/editing a place doesn't
re-trigger it). Gated on `isTimeSlotPollEnabled(chatId)`.

The picker reuses the *same* tracked menu card (`updateMenuMessage`) rather than sending a new
message — after the plain confirmation text, the card is immediately re-rendered into the day-picker
screen.

**Day screen:** multi-select toggle buttons for `timeSlotPollWeekdays`, a mutually-exclusive
"🕐 Будь-коли" button (tapping it clears any specific day toggles; tapping a specific day clears
"Будь-коли"), "✅ Готово", and "‹ Назад" (abandons the whole poll, discards any in-progress
selection, reverts the card to the normal menu with the just-submitted place — same effect as a
"skip", framed as navigation back rather than a dedicated skip button).

**Hour screen** (shown only if `timeSlotPollTimes` is non-empty for this chat): same shape over
`timeSlotPollTimes` — its own independent "🕐 Будь-коли", "✅ Зберегти", and "‹ Назад" (returns to
the day screen, keeping the day selection). If `timeSlotPollTimes` is empty, saving happens right
after the day screen's "Готово".

On save: `addOrUpdateTimeSlotResponse`, then the card reverts to the normal menu text/keyboard.

**Editing later:** `buildMenuKeyboard` gains a "🗓 Моя доступність" row, visible only when
`isTimeSlotPollEnabled(chatId)` and the user's current submission `status === 'submitted'`. Tapping
it reopens the same wizard, pre-seeded from the existing `time_slot_responses` row.

## Aggregation and the winner announcement

`services/timeSlotPollService.ts`'s `getTimeSlotSuggestion(chatId, deadlineWeekday)`:

1. Reads `listTimeSlotResponses(chatId)`, filtered against `listBlockedUsersInGroup(chatId)` (a
   defensive re-check for the block-after-answer race, same reasoning as
   `getNonSubmittersInfo`/`getRatingSurveyContext`).
2. Counts votes per configured weekday (`timeSlotPollWeekdays`): a response with `daysAny` counts
   toward every weekday; otherwise toward each day in its `days` list.
3. Counts votes per configured time the same way (`timesAny` counts toward every time).
4. Picks the single best day: highest count; ties broken by cyclic closeness to `deadlineWeekday`,
   measured *forward from the deadline* — `(weekday - deadlineWeekday + 7) % 7`, smallest wins (the
   day right after the deadline is distance 1, the day right before next week's deadline is distance
   6). This is the mirror image of `getFinalReminderWeekday`'s own distance measure, not the same
   formula: that one measures forward *from* a candidate weekday *to* the deadline (ranking days
   before the deadline by nearness), whereas poll days all fall *after* the deadline, so the
   direction has to flip.
5. Picks the single best time (only if `timeSlotPollTimes` is non-empty): highest count; ties
   broken by earliest `HH:MM` (plain string comparison is correct for zero-padded 24h time).
6. Returns `null` if there were zero responses at all this week.

Called from both `scheduler.ts`'s automatic draw and `admin.ts`'s force-draw action — the same
"manual mirrors automatic" principle already used for `isRepeatWinner`/`buildDrawAnnouncement` — and
only when `isTimeSlotPollEnabled(chatId)`. `resetWeek` additionally calls
`clearTimeSlotResponses(chatId)`.

`buildDrawAnnouncement` gets a new optional parameter; when present, appends:

```
📅 Пропозиція: субота, 10:00 — якщо комусь не підходить, домовляйтесь окремо
```

(day only, no time clause, when `timeSlotPollTimes` is empty for that chat). Nothing is appended
when the suggestion is `null` (feature disabled, or zero responses).

## Blocked-user interaction

- `blockUserFromGroup` (`services/submissionService.ts`) additionally calls
  `removeTimeSlotResponse(chatId, userId)`, symmetric to its existing `removeSubmission` call — a
  blocked user's availability answer shouldn't keep influencing the suggestion any more than their
  place submission should keep occupying the draw pool.
- `unblockUserFromGroup` does not restore it (same as the submission it already doesn't restore).
- `getTimeSlotSuggestion` filters blocked users defensively regardless, covering the narrow
  block-after-answering race.

## Other edge cases

- **Pause/lock:** the poll is only reachable as a consequence of a successful `submitPlace`, which
  already rejects while paused/locked/blocked — no separate check needed here.
- **Resubmission:** does not re-trigger the poll (checked via existing-row-this-week above).
- **Decline:** never triggers the poll; `declinePlace`/`handleDeclineAction` are unchanged.
- **Admin changes days/hours mid-week:** already-collected responses are not re-validated against
  the new config — a response naming a day that's since been removed from
  `timeSlotPollWeekdays` still counts in that week's aggregate, consistent with how this codebase
  never retroactively re-validates other schedule edits either.
- **Feature disabled after some responses collected:** responses are kept but unused (see
  "Enable/disable" above).

## Audit log

`AdminAction` (`storage/auditLog.ts`) gains three variants: `'edit_timeslot_days'`,
`'edit_timeslot_times'` (from `/schedule`, only on an actually-applied change), and
`'toggle_timeslot_poll'` (from `/admin`).

## Testing

Following the `dezheremo-testing` skill's conventions (env var isolation, per-file chat-id
numbering):

- `storage/timeSlotResponses.test.ts`, `storage/timeSlotPollState.test.ts` — CRUD and per-chat
  isolation.
- `services/timeSlotPollService.test.ts` — vote counting (including "Будь-коли" contributing to
  every option), both tie-break rules, blocked-user exclusion, `null` on zero responses.
- `services/scheduleService.test.ts` — new deadline-conflict validation, both directions.
- `commands/menu.test.ts` — day/hour picker flow after a genuine submit, no re-trigger on
  resubmit/decline, stale-tap protection, the "🗓 Моя доступність" button's visibility conditions.
- `commands/admin.test.ts` — toggle behavior, block removing a response.
- `commands/schedule.test.ts` — the two new edit wizards, including the deadline-conflict rejection
  path.

The feature ships fully off by default (`time_slot_poll_enabled` starts empty), so every existing
test and every existing chat's behavior is unaffected until an admin explicitly enables it.
