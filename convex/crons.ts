import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Rolling inventory: always keep the next 12 hours of 15-minute slots on sale.
crons.interval("ensure upcoming slots", { minutes: 15 }, internal.slots.ensureUpcoming, {});

export default crons;
