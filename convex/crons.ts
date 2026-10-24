import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Rolling inventory: always keep the next 12 hours of 15-minute slots on sale.
crons.interval("ensure upcoming slots", { minutes: 15 }, internal.slots.ensureUpcoming, {});

// Watch rules: re-check upcoming inventory for price moves and last-minute deals.
crons.interval("watch sweep", { minutes: 5 }, internal.watch.sweep, {});

// Collections seat: plan follow-ups for overdue invoices (nothing is sent).
crons.interval("plan collections", { hours: 1 }, internal.collections.plan, {});

// Host autopilot (ADR 0007): the seller agent re-plans the next 12 hours of unsold slots every minute.
crons.interval("autopilot plan", { minutes: 1 }, internal.autopilot.planAll, {});

// Finance autopilot: the AR clerk reconciles new bank lines and chases what is still open.
crons.interval("finance autopilot", { minutes: 5 }, internal.financeAutopilot.tick, {});

export default crons;
