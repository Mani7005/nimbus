import { z } from "zod";

// Combined with JSON escaping these stay under express.json()'s default 100 kB body limit,
// so oversized fields get a 400 from validation instead of a 413 from the body parser.
export const MAX_CODE_LENGTH = 50_000;
export const MAX_INPUT_LENGTH = 20_000;
export const MAX_LANGUAGE_LENGTH = 32;

export const executeSchema = z.object({
  language: z.string().min(1).max(MAX_LANGUAGE_LENGTH),
  code: z.string().min(1).max(MAX_CODE_LENGTH),
  input: z.string().max(MAX_INPUT_LENGTH).optional(),
});

export type ExecuteRequestBody = z.infer<typeof executeSchema>;

// Execution.id uses Prisma's @default(cuid()), i.e. cuid v1: "c" followed by 24 lowercase base-36 characters.
const EXECUTION_ID = /^c[a-z0-9]{24}$/;

export const executionIdParamsSchema = z.object({
  id: z.string().regex(EXECUTION_ID, "Invalid execution id"),
});

export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 100;

/** GET /execute?limit=&cursor= — cursor is the id of the last execution on the previous page. */
export const executionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_PAGE_SIZE).default(DEFAULT_HISTORY_PAGE_SIZE),
  cursor: z.string().regex(EXECUTION_ID, "Invalid cursor").optional(),
});

export type ExecutionListQuery = z.infer<typeof executionListQuerySchema>;
