# CREAO live workflow

How the sponsor **network**, company knowledge, and background CREAO harnesses feed BillboardOS — without sitting in the 30-second sale loop.

**Background CREAO:** Company Research (price factors) · Screen Audience · Creative Safety · Invite (opportunity strategy)  
**Fast path:** Convex ranks the network, invites top 10 vibe matches, runs offers/counters/settlement  
**Not on this path:** Sales / Revenue rehearsal

## Diagram

```mermaid
flowchart TB
  subgraph Network["1. Sponsor network seed"]
    OP["Operator"]
    SP["sponsors:seed<br/>full Cal Hacks company pool"]
    KS["companyKnowledge.seedSponsors"]
    EMB["Bitdeer BAAI/bge-m3<br/>indexMissing"]
    KC["knowledgeCards"]
    KP["companyKnowledgePassages<br/>+ vector index"]
    OP --> SP --> KS
    KS --> KC
    KS --> KP
    KP --> EMB --> KP
  end

  subgraph Triggers["2. What wakes each agent"]
    T1["Advertiser / campaign / creative change"]
    T2["Device claim / online + cron every 15m"]
    T3["Creative attached"]
    T4["Price harness cron hourly"]
    T5["Cool-down / thin roster"]
  end

  subgraph Agents["3. Background CREAO harness"]
    CTX["agentContext<br/>card + citations"]
    CR["Company Research / Price<br/>company_research"]
    SA["Screen Audience<br/>screen_audience"]
    CS["Creative Safety<br/>creative_safety"]
    INV["Invite CREAO<br/>opportunity_strategy"]
    KC --> CTX
    KP --> CTX
    CTX --> CR
    T1 --> CR
    T4 --> CR
    T2 --> SA
    T3 --> CS
    T5 --> INV
    KC -.category.-> CS
  end

  subgraph Stores["4. What they write"]
    CORP["companyResearch<br/>tags · summary · priceFactor"]
    BB["billboards<br/>audienceTags · summary"]
    REV["creativeReviews<br/>→ host policy / approvals"]
    PREF["billboardInvitePrefs<br/>boost / demote"]
    STAT["inviteStats<br/>reject streak · cool-down"]
    CR --> CORP
    SA --> BB
    CS --> REV
    INV --> PREF
  end

  subgraph Fast["5. Fast sale path seconds"]
    RANK["Rank network by vibe match<br/>exclude cooled · apply prefs"]
    TOP10["Invite top 10"]
    PRICE["windowPrice<br/>model + people + brand"]
    ROUND["30s offer / counter / settle"]
    CORP --> RANK
    BB --> RANK
    PREF --> RANK
    STAT --> RANK
    RANK --> TOP10 --> ROUND
    CORP --> PRICE --> ROUND
    ROUND --> STAT
  end

  subgraph Parallel["Separate rehearsal — not on this path"]
    SR["Sales → Revenue<br/>creaoHandoffs"]
  end
```

Editable Mermaid source: [`docs/diagrams/creao-live-workflow.mmd`](../diagrams/creao-live-workflow.mmd)

## Read left to right

1. **Network** — Operator seeds the Cal Hacks company-sponsor pool (campaign + YouTube + buyer agent + research). Knowledge cards/passages are optional enrichment for CREAO context.
2. **Triggers** — Research/audience/safety wake on data changes or cron. Price harness refreshes stale `priceFactor` hourly. Invite harness wakes when someone cools down or the roster is thin.
3. **CREAO harness** — Minutes-scale. Writes tags, summaries, price factors, creative gates, and optional invite prefs. Never bids in the 30s window.
4. **Stores** — Results land in Convex tables the fast path already reads.
5. **Fast sale** — Rank full network by vibe match (`screen.audienceTags` × company tags), skip cooled companies, apply prefs, invite **top 10**, price and settle in seconds. Three consecutive price rejects → cool-down ~10 windows → next-best enters automatically.

## Design rules

- Missing CREAO env: Claude/rules fallback for research; Invite harness writes deterministic next-best prefs. Sales still run.
- Workpool + rate limiter bound CREAO/research fan-out so harness ticks cannot stampede credits.
- Sales → Revenue rehearsal stays parallel and does not feed the live invite set.
