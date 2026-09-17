import { badRequest } from './errors.js';
import { isUuid } from './validation.js';

export interface TodoCursor {
  deadlineAt: Date;
  taskId: string;
  storeId: string;
}

/**
 * Cursors are stateless (self-describing base64url JSON), so they keep
 * working after a service restart — no server-side pagination state.
 */
export function encodeTodoCursor(cursor: TodoCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.deadlineAt.toISOString(), cursor.taskId, cursor.storeId]),
  ).toString('base64url');
}

export function decodeTodoCursor(raw: string): TodoCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('shape');
    const [deadline, taskId, storeId] = parsed as [unknown, unknown, unknown];
    if (typeof deadline !== 'string' || typeof taskId !== 'string' || typeof storeId !== 'string') {
      throw new Error('types');
    }
    const deadlineAt = new Date(deadline);
    if (Number.isNaN(deadlineAt.getTime())) throw new Error('date');
    if (!isUuid(taskId) || !isUuid(storeId)) throw new Error('uuid');
    return { deadlineAt, taskId: taskId.toLowerCase(), storeId: storeId.toLowerCase() };
  } catch {
    throw badRequest('query param "cursor" is not a valid pagination cursor');
  }
}
