import { ConvexError, v } from "convex/values";
import {
  advertiserFields,
  auditEventFields,
  billboardFields,
  financeExceptionFields,
  playbackEventFields,
  quoteFields,
  slotFields,
} from "../schema";

/** Full-document validators (system fields + table fields) for `returns`. */
export const billboardDoc = v.object({
  _id: v.id("billboards"),
  _creationTime: v.number(),
  ...billboardFields,
});

export const advertiserDoc = v.object({
  _id: v.id("advertisers"),
  _creationTime: v.number(),
  ...advertiserFields,
});

export const playbackEventDoc = v.object({
  _id: v.id("playbackEvents"),
  _creationTime: v.number(),
  ...playbackEventFields,
});

export const slotDoc = v.object({
  _id: v.id("slots"),
  _creationTime: v.number(),
  ...slotFields,
});

export const quoteDoc = v.object({
  _id: v.id("quotes"),
  _creationTime: v.number(),
  ...quoteFields,
});

export const financeExceptionDoc = v.object({
  _id: v.id("financeExceptions"),
  _creationTime: v.number(),
  ...financeExceptionFields,
});

export const auditEventDoc = v.object({
  _id: v.id("auditEvents"),
  _creationTime: v.number(),
  ...auditEventFields,
});

/** Throws if `value` is empty or longer than `max` characters. */
export function assertBoundedString(name: string, value: string, max: number): void {
  if (value.trim().length === 0 || value.length > max) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${name} must be 1..${max} characters`,
    });
  }
}
