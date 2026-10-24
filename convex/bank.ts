import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { bankSource } from "./schema";
import { recordAudit } from "./lib/audit";
import { usd } from "./lib/reconcile";

const MAX_LINES_PER_INGEST = 200;

export const bankLineInput = v.object({
  source: bankSource,
  externalId: v.string(),
  /** Credit amount in US cents (positive). */
  amountMinor: v.number(),
  postedAt: v.number(),
  payerName: v.string(),
  memo: v.string(),
});

export type BankLineInput = {
  source: "nessie" | "fixture";
  externalId: string;
  amountMinor: number;
  postedAt: number;
  payerName: string;
  memo: string;
};

/**
 * Insert bank credits as `unmatched`. Idempotent on (source, externalId):
 * a re-delivered line is dropped and the drop is audited.
 */
export async function ingestBankLines(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  lines: BankLineInput[],
  actor: string,
): Promise<{ inserted: Id<"bankTransactions">[]; duplicates: string[] }> {
  if (lines.length > MAX_LINES_PER_INGEST) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `At most ${MAX_LINES_PER_INGEST} lines per ingest`,
    });
  }
  const inserted: Id<"bankTransactions">[] = [];
  const duplicates: string[] = [];
  for (const line of lines) {
    if (
      line.externalId.trim().length === 0 ||
      line.externalId.length > 128 ||
      line.payerName.length > 200 ||
      line.memo.length > 500 ||
      !Number.isSafeInteger(line.amountMinor) ||
      line.amountMinor <= 0 ||
      !Number.isFinite(line.postedAt) ||
      line.postedAt <= 0
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `Invalid bank line ${line.externalId.slice(0, 128)}`,
      });
    }
    const existing = await ctx.db
      .query("bankTransactions")
      .withIndex("by_source_and_externalId", (q) =>
        q.eq("source", line.source).eq("externalId", line.externalId),
      )
      .first();
    if (existing) {
      duplicates.push(line.externalId);
      await recordAudit(ctx, {
        workspaceId,
        traceId: `bank:${line.source}:${line.externalId}`,
        actor,
        type: "bank.duplicate_ignored",
        subjectId: existing._id,
        reason: `Bank line ${line.externalId} re-delivered by ${line.source}; already ingested, ignored`,
        data: { externalId: line.externalId, amountMinor: line.amountMinor },
      });
      continue;
    }
    const id = await ctx.db.insert("bankTransactions", {
      workspaceId,
      source: line.source,
      externalId: line.externalId,
      amountMinor: line.amountMinor,
      postedAt: line.postedAt,
      payerName: line.payerName,
      memo: line.memo,
      status: "unmatched",
      appliedMinor: 0,
    });
    inserted.push(id);
    await recordAudit(ctx, {
      workspaceId,
      traceId: `bank:${line.source}:${line.externalId}`,
      actor,
      type: "bank.ingested",
      subjectId: id,
      reason: `${line.source} credit ${usd(line.amountMinor)} from ${line.payerName} ("${line.memo}")`,
      data: { externalId: line.externalId, source: line.source, amountMinor: line.amountMinor },
    });
  }
  return { inserted, duplicates };
}

/**
 * Bank feed entry point.
 * TODO(nessie): a "use node"-free action `bank.syncNessie` will fetch deposits
 * from the Nessie sandbox (key in env), map them to BankLineInput with
 * source "nessie", and call `ctx.runMutation(internal.bank.ingest, { lines })`.
 */
export const ingest = internalMutation({
  args: { workspaceId: v.id("workspaces"), lines: v.array(bankLineInput) },
  returns: v.object({
    inserted: v.number(),
    duplicates: v.array(v.string()),
    insertedIds: v.array(v.id("bankTransactions")),
  }),
  handler: async (ctx, args) => {
    const result = await ingestBankLines(ctx, args.workspaceId, args.lines, "system:bank-feed");
    return {
      inserted: result.inserted.length,
      duplicates: result.duplicates,
      insertedIds: result.inserted,
    };
  },
});
