/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audience from "../audience.js";
import type * as audit from "../audit.js";
import type * as billboards from "../billboards.js";
import type * as dashboard from "../dashboard.js";
import type * as finance from "../finance.js";
import type * as holds from "../holds.js";
import type * as http from "../http.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_validators from "../lib/validators.js";
import type * as payments from "../payments.js";
import type * as quotes from "../quotes.js";
import type * as seed from "../seed.js";
import type * as slots from "../slots.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  audience: typeof audience;
  audit: typeof audit;
  billboards: typeof billboards;
  dashboard: typeof dashboard;
  finance: typeof finance;
  holds: typeof holds;
  http: typeof http;
  "lib/audit": typeof lib_audit;
  "lib/constants": typeof lib_constants;
  "lib/pricing": typeof lib_pricing;
  "lib/validators": typeof lib_validators;
  payments: typeof payments;
  quotes: typeof quotes;
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
