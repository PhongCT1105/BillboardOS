/**
 * The 10 simulated advertisers: Cal Hacks 13.0 sponsors, each with its own
 * official YouTube ad (every URL passed YouTube's oEmbed check, 2026-10-24).
 * Simulated accounts: the companies didn't sign up; their agents are run by
 * BillboardOS (sponsors.ts seeds them).
 */
export type Sponsor = {
  name: string;
  youtubeUrl: string;
  youtubeTitle: string;
  youtubeAuthor: string;
  summary: string;
  /** Who buys from it (segment shares, sum 1): the research agent refines this. */
  targetAudience: Record<string, number>;
  dailyBudgetMinor: number;
};

export const SPONSORS: Sponsor[] = [
  {
    "name": "Anthropic",
    "youtubeUrl": "https://www.youtube.com/watch?v=FDNkDBNR7AM",
    "youtubeTitle": "Keep thinking with Claude",
    "youtubeAuthor": "Anthropic",
    "summary": "Anthropic is an AI safety and research company that builds the Claude family of AI models. It sells Claude to individuals and teams through claude.ai subscriptions and to developers and enterprises through the Claude API and Claude Code.",
    "targetAudience": {
      "software": 0.4,
      "office": 0.3,
      "startups": 0.2,
      "students": 0.1
    },
    "dailyBudgetMinor": 450
  },
  {
    "name": "Coinbase",
    "youtubeUrl": "https://www.youtube.com/watch?v=0V4CCxskN_0",
    "youtubeTitle": "Your Way Out",
    "youtubeAuthor": "Coinbase",
    "summary": "Coinbase is a publicly traded US cryptocurrency exchange where retail users and institutions buy, sell, store and trade crypto assets. It also runs the Base blockchain and the Coinbase Developer Platform for builders creating onchain apps.",
    "targetAudience": {
      "investors": 0.5,
      "finance": 0.2,
      "software": 0.15,
      "startups": 0.15
    },
    "dailyBudgetMinor": 400
  },
  {
    "name": "Convex",
    "youtubeUrl": "https://www.youtube.com/watch?v=UVvd7BF99-4",
    "youtubeTitle": "Intro to Convex",
    "youtubeAuthor": "Convex",
    "summary": "Convex is a reactive backend platform that combines a database, TypeScript server functions and real-time sync so app data updates live in clients. It is sold to developers and startups building full-stack web and AI apps, with a free tier and usage-based paid plans.",
    "targetAudience": {
      "software": 0.6,
      "startups": 0.3,
      "students": 0.1
    },
    "dailyBudgetMinor": 200
  },
  {
    "name": "Microsoft",
    "youtubeUrl": "https://www.youtube.com/watch?v=c5dsS21bt04",
    "youtubeTitle": "Microsoft Copilot: Work, transformed",
    "youtubeAuthor": "Microsoft Copilot",
    "summary": "Microsoft sells software, cloud and devices, including Windows, Microsoft 365, the Azure cloud platform and the Copilot AI assistant. Its customers range from consumers and students to developers and large enterprises.",
    "targetAudience": {
      "office": 0.5,
      "software": 0.25,
      "students": 0.15,
      "families": 0.1
    },
    "dailyBudgetMinor": 500
  },
  {
    "name": "Fetch.ai",
    "youtubeUrl": "https://www.youtube.com/watch?v=95k49sF7aG4",
    "youtubeTitle": "Embrace the future of connectivity with Fetch.ai AI Agent technology",
    "youtubeAuthor": "FetchAI",
    "summary": "Fetch.ai builds an ecosystem for autonomous AI agents: the uAgents framework and Agentverse marketplace for developers, plus ASI:One, a personal AI that routes requests to brand agents. It targets developers and businesses building agents, and its FET token is part of the ASI Alliance.",
    "targetAudience": {
      "software": 0.45,
      "investors": 0.3,
      "startups": 0.25
    },
    "dailyBudgetMinor": 200
  },
  {
    "name": "CREAO",
    "youtubeUrl": "https://www.youtube.com/watch?v=3c2uNDjWNeg",
    "youtubeTitle": "Introducing CREAO: The Super Agent that delivers beyond the chat window.",
    "youtubeAuthor": "Creao AI",
    "summary": "CREAO is a no-code AI agent platform whose agents plug into existing tools, learn how a user operates and run recurring work around the clock. It is aimed at founders, creators, freelancers and small teams who want to automate their business without writing code.",
    "targetAudience": {
      "startups": 0.5,
      "office": 0.3,
      "students": 0.2
    },
    "dailyBudgetMinor": 100
  },
  {
    "name": "Capital One",
    "youtubeUrl": "https://www.youtube.com/watch?v=qLielIlvHfY",
    "youtubeTitle": "Venture X Card - Globe Hopping 3.0 :30 | Capital One",
    "youtubeAuthor": "Capital One",
    "summary": "Capital One is a major US bank known for credit cards such as the Venture X travel card, plus checking and savings accounts, auto loans and commercial banking. It serves consumers, travelers and small businesses, largely through digital channels.",
    "targetAudience": {
      "families": 0.35,
      "tourists": 0.25,
      "finance": 0.25,
      "office": 0.15
    },
    "dailyBudgetMinor": 500
  },
  {
    "name": "Apify",
    "youtubeUrl": "https://www.youtube.com/watch?v=jBzXXZpDkf4",
    "youtubeTitle": "Every agent needs proper tools | Equip your AI on Apify",
    "youtubeAuthor": "Apify",
    "summary": "Apify is a web scraping and automation platform with a marketplace (Apify Store) of thousands of ready-to-run tools called Actors for extracting real-time web data. Developers, data teams and AI agents use it for lead generation, competitor tracking and feeding web data into apps.",
    "targetAudience": {
      "software": 0.55,
      "startups": 0.3,
      "office": 0.15
    },
    "dailyBudgetMinor": 200
  },
  {
    "name": "Cartesia",
    "youtubeUrl": "https://www.youtube.com/watch?v=AR_wclNEUPM",
    "youtubeTitle": "Introducing Multilingual Voices",
    "youtubeAuthor": "Cartesia AI",
    "summary": "Cartesia builds real-time voice AI: Sonic text-to-speech, Ink speech-to-text and a platform for production voice agents in dozens of languages. It sells via API to developers and enterprises building low-latency voice agents for things like customer support and call routing.",
    "targetAudience": {
      "software": 0.6,
      "startups": 0.3,
      "office": 0.1
    },
    "dailyBudgetMinor": 150
  },
  {
    "name": "Bright Data",
    "youtubeUrl": "https://www.youtube.com/watch?v=GL7pSAXG_Zw",
    "youtubeTitle": "Turning the Web Into AI-Ready Data for the Next Generation of AI",
    "youtubeAuthor": "Bright Data",
    "summary": "Bright Data provides web data infrastructure: proxy networks, scraping and search APIs, ready-made datasets and agent web access (including an MCP server). It serves over 50,000 organizations, from e-commerce and finance teams to AI labs that need public web data at scale.",
    "targetAudience": {
      "software": 0.5,
      "office": 0.25,
      "finance": 0.25
    },
    "dailyBudgetMinor": 300
  }
];
