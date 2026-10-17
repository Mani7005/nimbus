import type { Execution, PrismaClient } from "@prisma/client";

export interface ExecutionPage {
  executions: Execution[];
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  nextCursor: string | null;
}

/**
 * One page of the user's executions, newest first, with id breaking ties between equal timestamps so the order is
 * total and pages never overlap or skip rows. The cursor is looked up within the user's own executions, so another
 * user's id behaves exactly like a nonexistent one. Returns null for such an invalid cursor.
 */
export async function listExecutionsPage(
  db: PrismaClient,
  userId: string,
  { limit, cursor }: { limit: number; cursor?: string },
): Promise<ExecutionPage | null> {
  let after: { id: string; createdAt: Date } | null = null;
  if (cursor) {
    after = await db.execution.findFirst({ where: { id: cursor, userId }, select: { id: true, createdAt: true } });
    if (!after) return null;
  }

  const rows = await db.execution.findMany({
    where: {
      userId,
      ...(after && { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const executions = hasMore ? rows.slice(0, limit) : rows;
  return { executions, nextCursor: hasMore ? executions[executions.length - 1].id : null };
}
