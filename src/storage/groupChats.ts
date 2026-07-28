import path from 'node:path';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile.js';

// Override lets tests point this at an isolated temp directory instead of the real data/ folder.
const DATA_DIR = process.env.DEZHEREMO_DATA_DIR ?? path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'groupChats.json');

function load(): Map<number, string> {
  const parsed = readJsonFile<unknown>(DATA_FILE, {});
  // Pre-migration format was a bare array of chat ids with no title — treat those as
  // "title unknown yet"; addGroupChat backfills it the next time the bot sees that chat.
  if (Array.isArray(parsed)) {
    return new Map(parsed.map((chatId: number) => [chatId, '']));
  }
  return new Map(Object.entries(parsed as Record<string, string>).map(([chatId, title]) => [Number(chatId), String(title)]));
}

const groupChats = load();

function persist(): void {
  writeJsonFileAtomic(DATA_FILE, Object.fromEntries(groupChats));
}

export function addGroupChat(chatId: number, title: string): void {
  if (groupChats.get(chatId) === title) return;
  groupChats.set(chatId, title);
  persist();
}

export function removeGroupChat(chatId: number): void {
  if (!groupChats.has(chatId)) return;
  groupChats.delete(chatId);
  persist();
}

export function listGroupChats(): number[] {
  return Array.from(groupChats.keys());
}

export function getGroupChatTitle(chatId: number): string | undefined {
  return groupChats.get(chatId) || undefined;
}
