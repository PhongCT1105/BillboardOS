# ADR 0007 — Autopilot: AI-native, real-time, both sides

**Date:** 2026-10-24  
**Status:** Accepted (team direction)  
**Builds on:**
- [ADR 0003](0003-pricing-harness-and-bidding.md): pricing harness
- [ADR 0004](0004-two-sided-marketplace.md): hosts, customers, agents
- [ADR 0006](0006-live-moment-30-seconds.md): live moment
- [Live auction for real usage](../superpowers/specs/2026-10-24-live-auction-real-usage-design.md): the "now" path, already built

## Context

The live auction sells the **current** spot when the camera sees people: announce, bid, pay, play. Nobody clicks.

Everything else still waits for a person to click: opening an auction, booking a slot, deciding what to do with the evening. The team wants BillboardOS to run as an **AI-native business on both sides**:

- **The clock drives everything.** At 4:00 PM with nothing booked after now, the system is already working to fill 4:15, 5:00 and the evening, without anyone pressing a button.
- **Past is past.** Slots before now are history: shown as played, unsold or failed, never clickable.
- **People set goals and limits; agents do the work.**
  - Hosts set a floor, a starting rate and how hard to push.
  - Advertisers set a profile, a reach target and budgets.
  - The agents on both sides do the rest and explain each decision.

## Decision

### 1. Host autopilot: the seller agent fills the next 12 hours

It's on by default for every workspace; the owner can pause it. Every minute, and on events (a new screen, an event added, a crowd change, a slot freed), it reviews each unsold upcoming slot on each screen and decides:

| Time until the slot | What the seller agent does |
|---|---|
| **Now / current spot** | Leave it to the live auction (already built). |
| **15 min – 2 h** | Sell ahead. Offer the slot to every company agent whose profile, reach forecast and limits fit, at a **forecast price**. If two or more want the same slot, it opens a scheduled ascending auction automatically (`auctions.ts`, no button). As the slot nears with no buyer, the price decays toward the floor (falling price for perishable stock), never below it. |
| **2 – 12 h** | Publish an **early-booking price**: a modest discount for committing early. Offer it to fitting agents. Raise it when the forecast or demand rises. |

The **forecast** uses the same pieces as today's pricing, with one change: it predicts instead of reading the live camera.

- **Expected people** = the screen's normal traffic × an hour-of-day curve × known events (seeded or entered by the host) × the recent camera trend, with confidence falling the further ahead it looks.
- **Value** = expected people in view × plays in the spot ÷ 1,000 × the reference CPM × audience relevance (the live auction's formula).

Every decision is written to an **autopilot log** with its reasoning. For example:

> 5:00–5:15 PM unsold, 45 min out; forecast 12 people (Startup Demo Day ×1.3); offered to Nvidia and LaunchKit at $0.95; Nvidia booked.

The owner sees the log as a live feed.

### 2. Advertiser autopilot: each company's agent plans its budget

It extends the server-run company agents that already bid in live auctions:

- **Budget pacing.** The daily budget is split between **booking ahead** (default 60%) and **live auctions** (40%), so the agent never spends everything early.
- **Booking ahead.** It accepts forward offers when the forecast reach meets its target and the value to it (forecast reach × profile match) covers the price. It prefers slots with matching events. It pays at booking time over x402 from its own wallet, with a real transaction hash.
- **Its own log.** "Booked 5:00 PM at Moscone West for $0.95: 12 expected people, 70% founders, Demo Day."

Advertisers set only their profile, reach target, max per spot and daily budget. There are no bidding knobs.

### 3. Real-time UI rules (both sides)

- **Slot board and booking page show three zones:** past (greyed, labelled played, unsold or failed, not clickable), **now** (highlighted with progress), and future (price, forecast and status, or who booked it).
- **No manual trigger buttons on the demo path.** "Open auction", "simulate" and "mark paid" are gone. The host sees the autopilot working. A per-workspace pause and an owner-only "sell this slot now" override stay in settings for emergencies.
- **Host console:** an **Autopilot** panel at the top shows what it is doing now, what's booked ahead, unsold hours at risk, and its reasoning.
- **Advertiser dashboard:** a **Plan** panel shows booked spots (upcoming and played), spend against budget split between ahead and live, and its reasoning.
- **Copy says what the agents do.** For example: "Your agent booked 3 spots for tonight", not "Book a slot".

### 4. YouTube ads and a company knowledge base

- **YouTube ads.** An ad can be a YouTube link instead of an uploaded file. The player shows it through YouTube's official embedded player: autoplay, muted, looped, no controls. We never download or re-host the video. The embedded player's events produce the playback receipt and the "first frame" time. Approval stays with the host. Ads stay at most 30 seconds per play; longer videos play their first 30 seconds per loop.
- **Company knowledge base.** When a company is created or its agent is set up, a pipeline gathers **general information about the company**: what it does, its category and stage (most are startups), its audience. Sources are the existing Claude research with web search (ADR 0003 company valuation) and YouTube's public lookup for each linked video (title and channel). The result is stored as a **knowledge card** in Convex with a full-text search index and structured audience tags. It is reused for:
  - targeting and the reasoning text;
  - prefilling a new campaign's profile;
  - "similar companies" when matching offers.

  Deep video analysis (frames, transcripts) is deferred.

## Calls made by Claude (check these)

- Autopilot is on by default for both sides.
- The horizon is 12 hours, re-planned every minute.
- The advertiser budget split defaults to 60% ahead and 40% live.
- Forward bookings are paid at booking time over x402, not at airtime.
- Early-booking prices sit modestly below the forecast value; prices decay toward the floor as unsold slots near; a scheduled auction opens automatically on contention.
- Owner-only pause and "sell now" override stay as emergency controls in settings.
- YouTube plays through the official embedded player only; ads are capped at 30 s per play.
- The knowledge base is company-level only; deep video analysis is deferred.
