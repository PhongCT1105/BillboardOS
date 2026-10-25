import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Rolling inventory: always keep the next 12 hours of 15-minute slots on sale.
crons.interval("ensure upcoming slots", { minutes: 15 }, internal.slots.ensureUpcoming, {});

// Collections seat: plan follow-ups for overdue invoices (nothing is sent).
crons.interval("plan collections", { hours: 1 }, internal.collections.plan, {});

// Finance autopilot: the AR clerk reconciles new bank lines and chases what is still open.
crons.interval("finance autopilot", { minutes: 5 }, internal.financeAutopilot.tick, {});

// Rounds: offer the spot on air on every paired, online screen whose spot is unsold (unless the host turned it off).
crons.interval("auto-sell rounds", { minutes: 1 }, internal.rounds.autoSellTick, {});

// Screens: a device that stopped sending heartbeats goes offline.
crons.interval("screen heartbeats", { minutes: 1 }, internal.devices.markOffline, {});

// Audience agent: re-read who is in front of each online screen every hour.
crons.interval("audience read", { minutes: 15 }, internal.research.audienceSweep, {});

export default crons;
