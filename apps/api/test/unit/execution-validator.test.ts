import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { validateBody, validateParams } from "../../src/middleware/validate.middleware.js";
import {
  MAX_CODE_LENGTH,
  MAX_INPUT_LENGTH,
  MAX_LANGUAGE_LENGTH,
  executeSchema,
  executionIdParamsSchema,
} from "../../src/validators/execution.validator.js";

const VALID_ID = "cmrm5whp00000ieqonyoqlbge";

function run(middleware: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>) {
  const outcome = { status: 0, body: undefined as unknown, nextCalled: false };
  const res = {
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json(body: unknown) {
      outcome.body = body;
      return res;
    },
  };
  middleware(req as Request, res as unknown as Response, () => {
    outcome.nextCalled = true;
  });
  return outcome;
}

describe("executeSchema", () => {
  it("accepts a valid request with and without input", () => {
    assert.ok(executeSchema.safeParse({ language: "cpp", code: "int main() {}", input: "1 2" }).success);
    assert.ok(executeSchema.safeParse({ language: "cpp", code: "int main() {}" }).success);
    assert.ok(executeSchema.safeParse({ language: "cpp", code: "int main() {}", input: "" }).success);
  });

  it("accepts values exactly at the limits", () => {
    const body = { language: "c".repeat(MAX_LANGUAGE_LENGTH), code: "x".repeat(MAX_CODE_LENGTH), input: "y".repeat(MAX_INPUT_LENGTH) };
    assert.ok(executeSchema.safeParse(body).success);
  });

  for (const [name, body] of [
    ["missing language", { code: "x" }],
    ["missing code", { language: "cpp" }],
    ["empty language", { language: "", code: "x" }],
    ["empty code", { language: "cpp", code: "" }],
    ["non-string language", { language: 1, code: "x" }],
    ["non-string code", { language: "cpp", code: ["x"] }],
    ["non-string input", { language: "cpp", code: "x", input: 42 }],
    ["null input", { language: "cpp", code: "x", input: null }],
    ["oversized code", { language: "cpp", code: "x".repeat(MAX_CODE_LENGTH + 1) }],
    ["oversized input", { language: "cpp", code: "x", input: "y".repeat(MAX_INPUT_LENGTH + 1) }],
    ["oversized language", { language: "c".repeat(MAX_LANGUAGE_LENGTH + 1), code: "x" }],
    ["missing body", undefined],
    ["array body", []],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(executeSchema.safeParse(body).success, false);
    });
  }
});

describe("executionIdParamsSchema", () => {
  it("accepts a Prisma cuid", () => {
    assert.ok(executionIdParamsSchema.safeParse({ id: VALID_ID }).success);
  });

  for (const id of ["", "123", "not-an-id", VALID_ID.toUpperCase(), `${VALID_ID}x`, VALID_ID.slice(0, -1), "xmrm5whp00000ieqonyoqlbge", "cmrm5whp0000-ieqonyoqlbge", "cmrm5whp00000ieqonyoqlbg%"]) {
    it(`rejects malformed id ${JSON.stringify(id)}`, () => {
      assert.equal(executionIdParamsSchema.safeParse({ id }).success, false);
    });
  }
});

describe("validateBody", () => {
  it("calls next with the parsed body, dropping unknown keys", () => {
    const req: Partial<Request> = { body: { language: "cpp", code: "x", userId: "someone-else" } };
    const outcome = run(validateBody(executeSchema), req);
    assert.equal(outcome.nextCalled, true);
    assert.deepEqual(req.body, { language: "cpp", code: "x" });
  });

  it("responds 400 with the standard error shape and field paths", () => {
    const outcome = run(validateBody(executeSchema), { body: { language: "cpp", code: 5 } });
    assert.equal(outcome.nextCalled, false);
    assert.equal(outcome.status, 400);
    const body = outcome.body as { success: boolean; message: string };
    assert.equal(body.success, false);
    assert.match(body.message, /^code: /);
  });

  it("reports every invalid field", () => {
    const outcome = run(validateBody(executeSchema), { body: {} });
    const { message } = outcome.body as { message: string };
    assert.match(message, /language: /);
    assert.match(message, /code: /);
  });
});

describe("validateParams", () => {
  it("calls next for a valid id", () => {
    assert.equal(run(validateParams(executionIdParamsSchema), { params: { id: VALID_ID } }).nextCalled, true);
  });

  it("responds 400 for a malformed id", () => {
    const outcome = run(validateParams(executionIdParamsSchema), { params: { id: "123" } });
    assert.equal(outcome.nextCalled, false);
    assert.equal(outcome.status, 400);
    assert.deepEqual(outcome.body, { success: false, message: "id: Invalid execution id" });
  });
});
