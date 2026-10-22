export interface ActivityDelta { day: string; added: number; removed: number }
type History = 'undo' | 'redo';
interface Step { before: string; after: string; delta: ActivityDelta }
interface Session { current: string; undo: Step[]; redo: Step[] }

const DOCUMENT_BUDGET = 1024 * 1024;
const TOTAL_BUDGET = 4 * 1024 * 1024;
const MAX_STEPS = 64;
const DIFF_BUDGET = 250000;

export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function pointLength(value: string): number {
  let count = 0;
  for (const _point of value) count++;
  return count;
}
function previousPoint(value: string, end: number): number {
  const last = value.charCodeAt(end - 1);
  return end > 1 && last >= 0xdc00 && last <= 0xdfff && value.charCodeAt(end - 2) >= 0xd800 && value.charCodeAt(end - 2) <= 0xdbff ? end - 2 : end - 1;
}

/** Crop unchanged text first; the bounded diff never allocates a document-sized matrix. */
export function countChanges(before: string, after: string): { added: number; removed: number } {
  let prefix = 0, aEnd = before.length, bEnd = after.length;
  while (prefix < aEnd && prefix < bEnd && before.codePointAt(prefix) === after.codePointAt(prefix)) prefix += before.codePointAt(prefix)! > 0xffff ? 2 : 1;
  while (aEnd > prefix && bEnd > prefix) {
    const a = previousPoint(before, aEnd), b = previousPoint(after, bEnd);
    if (before.slice(a, aEnd) !== after.slice(b, bEnd)) break;
    aEnd = a; bEnd = b;
  }
  const left = before.slice(prefix, aEnd), right = after.slice(prefix, bEnd);
  if (!left || !right) return { added: pointLength(right), removed: pointLength(left) };
  if (left.length * right.length <= DIFF_BUDGET) {
    const a = Array.from(left), b = Array.from(right);
    const row = new Uint32Array(b.length + 1);
    for (const point of a) {
      let diagonal = 0;
      for (let index = 1; index <= b.length; index++) {
        const previous = row[index];
        row[index] = point === b[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
        diagonal = previous;
      }
    }
    return { added: b.length - row[b.length], removed: a.length - row[b.length] };
  }
  // Keep only the frontier, including for large Unicode documents.
  const aLength = pointLength(left), bLength = pointLength(right);
  const replacement = { added: bLength, removed: aLength };
  const limit = 256, offset = limit + 1;
  const frontier: ({ x: number; y: number } | undefined)[] = new Array(2 * limit + 3);
  frontier[offset + 1] = { x: 0, y: 0 };
  const budget = Math.max(DIFF_BUDGET, 2 * (left.length + right.length));
  let work = 0;
  for (let distance = 0; distance <= limit; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const slot = offset + diagonal, deletion = frontier[slot - 1], insertion = frontier[slot + 1];
      frontier[slot] = undefined;
      const down = diagonal === -distance || (diagonal !== distance && (deletion?.x ?? -1) < (insertion?.x ?? -1));
      const previous = down ? insertion : deletion;
      if (!previous) continue;
      let { x, y } = previous;
      if (distance > 0) {
        if (down) {
          if (y >= right.length) continue;
          y += right.codePointAt(y)! > 0xffff ? 2 : 1;
        } else {
          if (x >= left.length) continue;
          x += left.codePointAt(x)! > 0xffff ? 2 : 1;
        }
      }
      while (x < left.length && y < right.length && left.codePointAt(x) === right.codePointAt(y)) {
        const width = left.codePointAt(x)! > 0xffff ? 2 : 1;
        x += width; y += width;
        if (++work > budget) return replacement;
      }
      frontier[slot] = { x, y };
      if (x >= left.length && y >= right.length) return { added: (distance + bLength - aLength) / 2, removed: (distance + aLength - bLength) / 2 };
      if (++work > budget) return replacement;
    }
  }
  // A large replacement is represented as a replacement of the cropped span.
  return replacement;
}
function combine(steps: Step[], sign: 1 | -1): ActivityDelta[] {
  const days = new Map<string, ActivityDelta>();
  for (const { delta } of steps) {
    const day = days.get(delta.day) || { day: delta.day, added: 0, removed: 0 };
    day.added += sign * delta.added; day.removed += sign * delta.removed;
    days.set(delta.day, day);
  }
  return [...days.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
}
function bytes(session: Session): number {
  return 2 * (session.current.length + [...session.undo, ...session.redo].reduce((sum, step) => sum + step.before.length + step.after.length, 0));
}

export class ActivityTracker {
  private sessions = new Map<string, Session>();
  private now: () => Date;
  constructor(now: () => Date = () => new Date()) { this.now = now; }

  /** External writes invalidate editor-history attribution, including pending redo. */
  reset(documentId: string) { this.sessions.delete(documentId); }

  record(documentId: string, beforePlain: string, afterPlain: string, history?: History): ActivityDelta[] {
    const before = beforePlain, after = afterPlain;
    let session = this.sessions.get(documentId);
    if (before === after) {
      if (session && session.current !== before) this.reset(documentId);
      return [];
    }
    if (!session || session.current !== before) {
      session = { current: before, undo: [], redo: [] };
      this.sessions.set(documentId, session);
    }
    this.sessions.delete(documentId); this.sessions.set(documentId, session);
    let result: ActivityDelta[] = [];
    if (history) {
      const stack = history === 'undo' ? session.undo : session.redo;
      let match = -1;
      for (let index = stack.length - 1; index >= 0; index--) {
        if ((history === 'undo' ? stack[index].before : stack[index].after) === after) { match = index; break; }
      }
      if (match >= 0) {
        const steps = stack.splice(match).reverse();
        if (history === 'undo') session.redo.push(...steps); else session.undo.push(...steps);
        result = combine(steps, history === 'undo' ? -1 : 1);
      } else {
        // Unknown/coalesced-out history cannot be claimed as a human edit.
        session.undo = []; session.redo = [];
      }
    } else {
      const delta = { day: localDay(this.now()), ...countChanges(before, after) };
      session.undo.push({ before, after, delta }); session.redo = [];
      result = delta.added || delta.removed ? [delta] : [];
    }
    session.current = after;
    while (session.undo.length + session.redo.length > MAX_STEPS || (bytes(session) > DOCUMENT_BUDGET && (session.undo.length || session.redo.length))) {
      if (session.undo.length) session.undo.shift(); else session.redo.shift();
    }
    // An active large document may keep its current baseline, never unlimited historical copies.
    let total = [...this.sessions.values()].reduce((sum, value) => sum + bytes(value), 0);
    for (const [id, value] of this.sessions) {
      if ((total <= TOTAL_BUDGET && this.sessions.size <= 8) || id === documentId) continue;
      total -= bytes(value); this.sessions.delete(id);
    }
    return result;
  }
}
