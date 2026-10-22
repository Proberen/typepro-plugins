import { localDay } from './tracker.ts';

export interface ActivityDocument { documentId: string; title: string; added: number; removed: number }
export interface ActivityDay { day: string; added: number; removed: number; documents: ActivityDocument[] }
export interface ActivityEntry { key: string; value: unknown }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseCalendarDay(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return localDay(date) === value ? date : null;
}
export function activityDays(entries: ActivityEntry[]): Map<string, ActivityDay> {
  const days = new Map<string, ActivityDay>();
  for (const entry of entries) {
    if (!entry.key.startsWith('activity.') || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue;
    const value = entry.value as Record<string, unknown>;
    const prefix = `activity.${value.day}.${value.documentId}.`;
    if (!parseCalendarDay(value.day) || typeof value.documentId !== 'string' || !uuid.test(value.documentId)
      || !entry.key.startsWith(prefix) || !uuid.test(entry.key.slice(prefix.length))
      || !Number.isSafeInteger(value.added) || !Number.isSafeInteger(value.removed) || Number(value.added) < 0 || Number(value.removed) < 0) continue;
    const day = value.day as string, added = value.added as number, removed = value.removed as number;
    const title = typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 1024) : '未命名文档';
    const aggregate = days.get(day) || { day, added: 0, removed: 0, documents: [] };
    if (!Number.isSafeInteger(aggregate.added + added) || !Number.isSafeInteger(aggregate.removed + removed)) continue;
    aggregate.added += added; aggregate.removed += removed;
    const document = aggregate.documents.find(item => item.documentId === value.documentId);
    if (document) { document.added += added; document.removed += removed; document.title = title; }
    else aggregate.documents.push({ documentId: value.documentId, title, added, removed });
    days.set(day, aggregate);
  }
  for (const day of days.values()) day.documents.sort((a, b) => b.added + b.removed - a.added - a.removed || a.title.localeCompare(b.title, 'zh-CN'));
  return days;
}

/** Calendar arithmetic at local noon remains stable over daylight saving transitions. */
export function activityCalendar(today: string): { days: string[]; weeks: number; start: string } {
  const date = parseCalendarDay(today);
  if (!date) return { days: [], weeks: 0, start: today };
  date.setDate(date.getDate() - 364);
  const start = localDay(date);
  date.setDate(date.getDate() - date.getDay());
  const days: string[] = [];
  while (localDay(date) <= today) {
    days.push(localDay(date));
    date.setDate(date.getDate() + 1);
  }
  while (days.length % 7) days.push('');
  return { days, weeks: days.length / 7, start };
}
