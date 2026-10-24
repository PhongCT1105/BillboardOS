/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as a2a from "../a2a.js";
import type * as accounts from "../accounts.js";
import type * as advertisers from "../advertisers.js";
import type * as agentApi from "../agentApi.js";
import type * as agentKeys from "../agentKeys.js";
import type * as alerts from "../alerts.js";
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
import type * as customerPortal from "../customerPortal.js";
import type * as dashboard from "../dashboard.js";
import type * as events from "../events.js";
import type * as finance from "../finance.js";
import type * as fixtures_financeAnswerKey from "../fixtures/financeAnswerKey.js";
import type * as fixtures_financeFixture from "../fixtures/financeFixture.js";
import type * as holds from "../holds.js";
import type * as http from "../http.js";
import type * as lib_agentKeys from "../lib/agentKeys.js";
import type * as lib_auction from "../lib/auction.js";
import type * as lib_audienceWindow from "../lib/audienceWindow.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_collections from "../lib/collections.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_finance from "../lib/finance.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_marketHistory from "../lib/marketHistory.js";
import type * as lib_match from "../lib/match.js";
import type * as lib_negotiation from "../lib/negotiation.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_screenPrice from "../lib/screenPrice.js";
import type * as lib_stages from "../lib/stages.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_valuation from "../lib/valuation.js";
import type * as lib_watch from "../lib/watch.js";
import type * as lib_webhook from "../lib/webhook.js";
import type * as migrations from "../migrations.js";
import type * as negotiations from "../negotiations.js";
import type * as payments from "../payments.js";
import type * as playback from "../playback.js";
import type * as player from "../player.js";
import type * as quotes from "../quotes.js";
import type * as reconciliation from "../reconciliation.js";
import type * as seed from "../seed.js";
import type * as slots from "../slots.js";
import type * as valuation from "../valuation.js";
import type * as valuationAgent from "../valuationAgent.js";
import type * as watch from "../watch.js";
import type * as watchDelivery from "../watchDelivery.js";
import type * as watchRules from "../watchRules.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  a2a: typeof a2a;
  accounts: typeof accounts;
  advertisers: typeof advertisers;
  agentApi: typeof agentApi;
  agentKeys: typeof agentKeys;
  alerts: typeof alerts;
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
  customerPortal: typeof customerPortal;
  dashboard: typeof dashboard;
  events: typeof events;
  finance: typeof finance;
  "fixtures/financeAnswerKey": typeof fixtures_financeAnswerKey;
  "fixtures/financeFixture": typeof fixtures_financeFixture;
  holds: typeof holds;
  http: typeof http;
  "lib/agentKeys": typeof lib_agentKeys;
  "lib/auction": typeof lib_auction;
  "lib/audienceWindow": typeof lib_audienceWindow;
  "lib/audit": typeof lib_audit;
  "lib/collections": typeof lib_collections;
  "lib/constants": typeof lib_constants;
  "lib/finance": typeof lib_finance;
  "lib/inventory": typeof lib_inventory;
  "lib/marketHistory": typeof lib_marketHistory;
  "lib/match": typeof lib_match;
  "lib/negotiation": typeof lib_negotiation;
  "lib/pricing": typeof lib_pricing;
  "lib/reconcile": typeof lib_reconcile;
  "lib/scheduling": typeof lib_scheduling;
  "lib/screenPrice": typeof lib_screenPrice;
  "lib/stages": typeof lib_stages;
  "lib/tenancy": typeof lib_tenancy;
  "lib/validators": typeof lib_validators;
  "lib/valuation": typeof lib_valuation;
  "lib/watch": typeof lib_watch;
  "lib/webhook": typeof lib_webhook;
  migrations: typeof migrations;
  negotiations: typeof negotiations;
  payments: typeof payments;
  playback: typeof playback;
  player: typeof player;
  quotes: typeof quotes;
  reconciliation: typeof reconciliation;
  seed: typeof seed;
  slots: typeof slots;
  valuation: typeof valuation;
  valuationAgent: typeof valuationAgent;
  watch: typeof watch;
  watchDelivery: typeof watchDelivery;
  watchRules: typeof watchRules;
  workspaces: typeof workspaces;
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
