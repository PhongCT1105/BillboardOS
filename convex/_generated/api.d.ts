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
import type * as approvals from "../approvals.js";
import type * as audience from "../audience.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as bank from "../bank.js";
import type * as billboards from "../billboards.js";
import type * as bookings from "../bookings.js";
import type * as campaigns from "../campaigns.js";
import type * as collections from "../collections.js";
import type * as companyAgents from "../companyAgents.js";
import type * as companyAgentsAct from "../companyAgentsAct.js";
import type * as companyAgentsNode from "../companyAgentsNode.js";
import type * as creao from "../creao.js";
import type * as creativeReview from "../creativeReview.js";
import type * as creativeReviewNode from "../creativeReviewNode.js";
import type * as creatives from "../creatives.js";
import type * as crons from "../crons.js";
import type * as customerPortal from "../customerPortal.js";
import type * as dashboard from "../dashboard.js";
import type * as devices from "../devices.js";
import type * as events from "../events.js";
import type * as finance from "../finance.js";
import type * as financeAutopilot from "../financeAutopilot.js";
import type * as fixtures_financeAnswerKey from "../fixtures/financeAnswerKey.js";
import type * as fixtures_financeFixture from "../fixtures/financeFixture.js";
import type * as fixtures_sponsors from "../fixtures/sponsors.js";
import type * as holds from "../holds.js";
import type * as http from "../http.js";
import type * as lib_agentKeys from "../lib/agentKeys.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_autopilotSchema from "../lib/autopilotSchema.js";
import type * as lib_collections from "../lib/collections.js";
import type * as lib_companyAgent from "../lib/companyAgent.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_creativeReview from "../lib/creativeReview.js";
import type * as lib_demoCrypto from "../lib/demoCrypto.js";
import type * as lib_finance from "../lib/finance.js";
import type * as lib_inventory from "../lib/inventory.js";
import type * as lib_match from "../lib/match.js";
import type * as lib_paymentLock from "../lib/paymentLock.js";
import type * as lib_reconcile from "../lib/reconcile.js";
import type * as lib_research from "../lib/research.js";
import type * as lib_roundHooks from "../lib/roundHooks.js";
import type * as lib_rounds from "../lib/rounds.js";
import type * as lib_sale from "../lib/sale.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_webhook from "../lib/webhook.js";
import type * as lib_x402_agentCard from "../lib/x402/agentCard.js";
import type * as lib_x402_cdpEngine from "../lib/x402/cdpEngine.js";
import type * as lib_x402_flow from "../lib/x402/flow.js";
import type * as lib_x402_money from "../lib/x402/money.js";
import type * as lib_youtube from "../lib/youtube.js";
import type * as migrations from "../migrations.js";
import type * as paymentLocks from "../paymentLocks.js";
import type * as payments from "../payments.js";
import type * as playback from "../playback.js";
import type * as player from "../player.js";
import type * as reconciliation from "../reconciliation.js";
import type * as research from "../research.js";
import type * as researchNode from "../researchNode.js";
import type * as roundDelivery from "../roundDelivery.js";
import type * as rounds from "../rounds.js";
import type * as schemaParts_knowledge from "../schemaParts/knowledge.js";
import type * as schemaParts_rounds from "../schemaParts/rounds.js";
import type * as schemaParts_sales from "../schemaParts/sales.js";
import type * as seed from "../seed.js";
import type * as slots from "../slots.js";
import type * as sponsors from "../sponsors.js";
import type * as workspaces from "../workspaces.js";
import type * as x402Node from "../x402Node.js";

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
  approvals: typeof approvals;
  audience: typeof audience;
  audit: typeof audit;
  auth: typeof auth;
  bank: typeof bank;
  billboards: typeof billboards;
  bookings: typeof bookings;
  campaigns: typeof campaigns;
  collections: typeof collections;
  companyAgents: typeof companyAgents;
  companyAgentsAct: typeof companyAgentsAct;
  companyAgentsNode: typeof companyAgentsNode;
  creao: typeof creao;
  creativeReview: typeof creativeReview;
  creativeReviewNode: typeof creativeReviewNode;
  creatives: typeof creatives;
  crons: typeof crons;
  customerPortal: typeof customerPortal;
  dashboard: typeof dashboard;
  devices: typeof devices;
  events: typeof events;
  finance: typeof finance;
  financeAutopilot: typeof financeAutopilot;
  "fixtures/financeAnswerKey": typeof fixtures_financeAnswerKey;
  "fixtures/financeFixture": typeof fixtures_financeFixture;
  "fixtures/sponsors": typeof fixtures_sponsors;
  holds: typeof holds;
  http: typeof http;
  "lib/agentKeys": typeof lib_agentKeys;
  "lib/audit": typeof lib_audit;
  "lib/autopilotSchema": typeof lib_autopilotSchema;
  "lib/collections": typeof lib_collections;
  "lib/companyAgent": typeof lib_companyAgent;
  "lib/constants": typeof lib_constants;
  "lib/creativeReview": typeof lib_creativeReview;
  "lib/demoCrypto": typeof lib_demoCrypto;
  "lib/finance": typeof lib_finance;
  "lib/inventory": typeof lib_inventory;
  "lib/match": typeof lib_match;
  "lib/paymentLock": typeof lib_paymentLock;
  "lib/reconcile": typeof lib_reconcile;
  "lib/research": typeof lib_research;
  "lib/roundHooks": typeof lib_roundHooks;
  "lib/rounds": typeof lib_rounds;
  "lib/sale": typeof lib_sale;
  "lib/scheduling": typeof lib_scheduling;
  "lib/tenancy": typeof lib_tenancy;
  "lib/validators": typeof lib_validators;
  "lib/webhook": typeof lib_webhook;
  "lib/x402/agentCard": typeof lib_x402_agentCard;
  "lib/x402/cdpEngine": typeof lib_x402_cdpEngine;
  "lib/x402/flow": typeof lib_x402_flow;
  "lib/x402/money": typeof lib_x402_money;
  "lib/youtube": typeof lib_youtube;
  migrations: typeof migrations;
  paymentLocks: typeof paymentLocks;
  payments: typeof payments;
  playback: typeof playback;
  player: typeof player;
  reconciliation: typeof reconciliation;
  research: typeof research;
  researchNode: typeof researchNode;
  roundDelivery: typeof roundDelivery;
  rounds: typeof rounds;
  "schemaParts/knowledge": typeof schemaParts_knowledge;
  "schemaParts/rounds": typeof schemaParts_rounds;
  "schemaParts/sales": typeof schemaParts_sales;
  seed: typeof seed;
  slots: typeof slots;
  sponsors: typeof sponsors;
  workspaces: typeof workspaces;
  x402Node: typeof x402Node;
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

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
