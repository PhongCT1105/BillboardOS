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
import type * as auctions from "../auctions.js";
import type * as audience from "../audience.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as bank from "../bank.js";
import type * as billboards from "../billboards.js";
import type * as bookings from "../bookings.js";
import type * as campaigns from "../campaigns.js";
import type * as collections from "../collections.js";
import type * as creatives from "../creatives.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as events from "../events.js";
import type * as finance from "../finance.js";
import type * as fixtures_financeAnswerKey from "../fixtures/financeAnswerKey.js";
import type * as fixtures_financeFixture from "../fixtures/financeFixture.js";
import type * as holds from "../holds.js";
import type * as http from "../http.js";
import type * as lib_auction from "../lib/auction.js";
import type * as lib_audienceWindow from "../lib/audienceWindow.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_collections from "../lib/collections.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_finance from "../lib/finance.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_marketHistory from "../lib/marketHistory.js";
import type * as lib_match from "../lib/match.js";
import type * as lib_operator from "../lib/operator.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_screenPrice from "../lib/screenPrice.js";
import type * as lib_stages from "../lib/stages.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_valuation from "../lib/valuation.js";
import type * as operators from "../operators.js";
import type * as payments from "../payments.js";
import type * as playback from "../playback.js";
import type * as player from "../player.js";
import type * as quotes from "../quotes.js";
import type * as reconciliation from "../reconciliation.js";
import type * as seed from "../seed.js";
import type * as slots from "../slots.js";
import type * as valuation from "../valuation.js";
import type * as valuationAgent from "../valuationAgent.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  advertisers: typeof advertisers;
  approvals: typeof approvals;
  auctions: typeof auctions;
  audience: typeof audience;
  audit: typeof audit;
  auth: typeof auth;
  bank: typeof bank;
  billboards: typeof billboards;
  bookings: typeof bookings;
  campaigns: typeof campaigns;
  collections: typeof collections;
  creatives: typeof creatives;
  crons: typeof crons;
  dashboard: typeof dashboard;
  events: typeof events;
  finance: typeof finance;
  "fixtures/financeAnswerKey": typeof fixtures_financeAnswerKey;
  "fixtures/financeFixture": typeof fixtures_financeFixture;
  holds: typeof holds;
  http: typeof http;
  "lib/auction": typeof lib_auction;
  "lib/audienceWindow": typeof lib_audienceWindow;
  "lib/audit": typeof lib_audit;
  "lib/collections": typeof lib_collections;
  "lib/constants": typeof lib_constants;
  "lib/finance": typeof lib_finance;
  "lib/inventory": typeof lib_inventory;
  "lib/marketHistory": typeof lib_marketHistory;
  "lib/match": typeof lib_match;
  "lib/operator": typeof lib_operator;
  "lib/pricing": typeof lib_pricing;
  "lib/reconcile": typeof lib_reconcile;
  "lib/scheduling": typeof lib_scheduling;
  "lib/screenPrice": typeof lib_screenPrice;
  "lib/stages": typeof lib_stages;
  "lib/validators": typeof lib_validators;
  "lib/valuation": typeof lib_valuation;
  operators: typeof operators;
  payments: typeof payments;
  playback: typeof playback;
  player: typeof player;
  quotes: typeof quotes;
  reconciliation: typeof reconciliation;
  seed: typeof seed;
  slots: typeof slots;
  valuation: typeof valuation;
  valuationAgent: typeof valuationAgent;
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
