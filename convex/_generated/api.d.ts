/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as advertisers from "../advertisers.js";
import type * as approvals from "../approvals.js";
import type * as audience from "../audience.js";
import type * as audit from "../audit.js";
import type * as bank from "../bank.js";
import type * as billboards from "../billboards.js";
import type * as bookings from "../bookings.js";
import type * as campaigns from "../campaigns.js";
import type * as collections from "../collections.js";
import type * as creatives from "../creatives.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as finance from "../finance.js";
import type * as fixtures_financeAnswerKey from "../fixtures/financeAnswerKey.js";
import type * as fixtures_financeFixture from "../fixtures/financeFixture.js";
import type * as holds from "../holds.js";
import type * as http from "../http.js";
import type * as lib_audienceWindow from "../lib/audienceWindow.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_collections from "../lib/collections.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_finance from "../lib/finance.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_validators from "../lib/validators.js";
import type * as payments from "../payments.js";
import type * as playback from "../playback.js";
import type * as player from "../player.js";
import type * as quotes from "../quotes.js";
import type * as reconciliation from "../reconciliation.js";
import type * as seed from "../seed.js";
import type * as slots from "../slots.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  advertisers: typeof advertisers;
  approvals: typeof approvals;
  audience: typeof audience;
  audit: typeof audit;
  bank: typeof bank;
  billboards: typeof billboards;
  bookings: typeof bookings;
  campaigns: typeof campaigns;
  collections: typeof collections;
  creatives: typeof creatives;
  crons: typeof crons;
  dashboard: typeof dashboard;
  finance: typeof finance;
  "fixtures/financeAnswerKey": typeof fixtures_financeAnswerKey;
  "fixtures/financeFixture": typeof fixtures_financeFixture;
  holds: typeof holds;
  http: typeof http;
  "lib/audienceWindow": typeof lib_audienceWindow;
  "lib/audit": typeof lib_audit;
  "lib/collections": typeof lib_collections;
  "lib/constants": typeof lib_constants;
  "lib/finance": typeof lib_finance;
  "lib/inventory": typeof lib_inventory;
  "lib/pricing": typeof lib_pricing;
  "lib/reconcile": typeof lib_reconcile;
  "lib/scheduling": typeof lib_scheduling;
  "lib/validators": typeof lib_validators;
  payments: typeof payments;
  playback: typeof playback;
  player: typeof player;
  quotes: typeof quotes;
  reconciliation: typeof reconciliation;
  seed: typeof seed;
  slots: typeof slots;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
