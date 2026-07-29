import { listBlockedUsersInGroup } from './submissionService.js';
import { getHistoricalSubmitters, type HistoricalSubmitter } from '../storage/history.js';
import { listSubmissions } from '../storage/store.js';

export interface NonSubmittersInfo {
  // People who submitted a place in some past week (so we know their user id) but haven't this
  // week — these can be named and @-tagged.
  nonSubmitters: HistoricalSubmitter[];
  // Group members the bot has never seen submit anything, ever — it knows they exist (from
  // totalMembers) but not who they are, so they can only be reported as a count.
  unknownCount: number;
}

// totalMembers comes from Telegram's getChatMembersCount, fetched by the caller — kept as a plain
// number param here so this stays a pure, easily testable function.
export function getNonSubmittersInfo(chatId: number, totalMembers: number): NonSubmittersInfo {
  const historical = getHistoricalSubmitters(chatId);
  const current = listSubmissions(chatId);
  const currentIds = new Set(current.map((s) => s.userId));
  // A blocked user can never submit this week no matter how long it goes on, so nudging them by
  // name every final reminder would be actively wrong — but they're still a known, accounted-for
  // member (they still count toward knownIds below), just not someone to tag.
  const blockedIds = new Set(listBlockedUsersInGroup(chatId).map((b) => b.userId));

  const nonSubmitters = historical.filter((u) => !currentIds.has(u.userId) && !blockedIds.has(u.userId));

  const knownIds = new Set([...historical.map((u) => u.userId), ...currentIds]);
  // -1 excludes the bot itself, which getChatMembersCount counts as a member.
  const unknownCount = Math.max(0, totalMembers - 1 - knownIds.size);

  return { nonSubmitters, unknownCount };
}
