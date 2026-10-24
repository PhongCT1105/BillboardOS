# Fetch.ai — Best Use of Fetch.ai

| | |
|---|---|
| **Type** | **Tool required.** Agent on Agentverse, usable through ASI:One. |
| **Prizes** | $1,250 / $750 / $500 (+ internship interview opportunity) · two $250 Special Recognition prizes. (The guide lists $1,500 / $1,000 / $500; the event page is newer.) |
| **Our target** | **P2** — only if someone owns the ASI:One flow end to end |
| **Rules status** | Event page + hackpack read 2026-10-24 |
| **Sources** | [event page](https://www.fetch.ai/events/calhacks-13-0) · [hackpack](https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack) · [Official guide] printed p. 11 |

## Mandatory requirements

- [ ] Register at least one agent on **Agentverse**.
- [ ] Implement the **Agent Chat Protocol**.
- [ ] Agent is discoverable and directly usable through **ASI:One**.
- [ ] Show meaningful tool execution or multi-agent orchestration.
- [ ] **The primary user workflow runs entirely inside an ASI:One conversation.**
- [ ] Public GitHub repo with run/test instructions.

## Judging criteria

| Weight | Criterion |
|---|---|
| 25% | Functionality & technical implementation |
| 20% | Use of Fetch.ai technology |
| 20% | Innovation & creativity |
| 20% | Real-world impact & usefulness |
| 15% | User experience & presentation |

**Bonus:** multi-agent collaboration · Payment Protocol with a credible monetization model · ASI Interactive Cards · reliability and recovery from failed tool calls · real-time data and external services · an agent that could keep operating after the event.

## Submission

- README lists each agent's **name and address** and any extra resources needed to run it.
- README includes both badges: `![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)` and `![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)`.
- All agents categorized under **Innovation Lab**.
- **3–5 minute demo video** of the agents.
- Submit on Devpost **and** through the Cal Hacks ASI:One Submission Agent.

## Tools

uAgents (Python library) · Agentverse (agent marketplace) · ASI:One (agentic LLM that routes requests to Agentverse agents) · Agent Chat Protocol · Payment Protocol.

## How BillboardOS fits (proposed)

An advertiser types "book me a billboard near Moscone next Saturday under $500" into ASI:One. ASI:One routes it to the **BillboardOS seller agent** on Agentverse, which calls our Convex API for inventory and quotes, negotiates within the floor, and completes payment (x402, or Fetch.ai's Payment Protocol for the bonus). The whole booking happens in the ASI:One conversation, which satisfies the "entirely inside ASI:One" rule.

**Cost:** a second front door (the web portal is the first), a Python service, and a separate 3–5 minute video.
