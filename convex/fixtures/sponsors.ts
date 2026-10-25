/**
 * Cal Hacks 13.0 company-sponsor network. Every entry is a simulated advertiser
 * with an official YouTube ad (oEmbed-checked) or a brand poster when no video
 * is available. BillboardOS runs their agents.
 *
 * The full list is the **network pool**. Each billboard invites only the top 10
 * vibe matches; cool-downs rotate chronic price-rejectors out.
 *
 * Skipped (no usable creative yet): Annapurna Labs, CRS, Moss, Factory,
 * Armadin, Notability, Mana, SpaceXSI.
 */

/** Brand-poster SVG for sponsors without a verified YouTube ad. */
export function brandPosterSvg(opts: {
  name: string;
  tagline: string;
  accent: string;
  site: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0B0F14"/><stop offset="100%" stop-color="#161D27"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect x="0" y="0" width="16" height="630" fill="${esc(opts.accent)}"/>
  <text x="72" y="250" fill="${esc(opts.accent)}" font-family="system-ui,sans-serif" font-size="64" font-weight="700">${esc(opts.name)}</text>
  <text x="72" y="330" fill="#E8EEF5" font-family="system-ui,sans-serif" font-size="34">${esc(opts.tagline)}</text>
  <text x="72" y="560" fill="#8B9AAB" font-family="system-ui,sans-serif" font-size="22">${esc(opts.site)}</text>
</svg>`;
}

export type Sponsor = {
  name: string;
  /** Present for YouTube creatives. */
  youtubeUrl?: string;
  youtubeTitle?: string;
  youtubeAuthor?: string;
  /** Present for brand-poster creatives (no verified YouTube). */
  posterTitle?: string;
  posterAuthor?: string;
  posterSvg?: string;
  /** Public page whose branding the poster is based on. */
  posterSourceUrl?: string;
  summary: string;
  /** Who buys from it (segment shares, sum 1): the research agent refines this. */
  targetAudience: Record<string, number>;
  dailyBudgetMinor: number;
};

export function sponsorCreativeTitle(s: Sponsor): string {
  return s.youtubeTitle ?? s.posterTitle ?? s.name;
}

export function sponsorCreativeAuthor(s: Sponsor): string {
  return s.youtubeAuthor ?? s.posterAuthor ?? s.name;
}

export function isPosterSponsor(s: Sponsor): boolean {
  return Boolean(s.posterSvg) && !s.youtubeUrl;
}

export const SPONSORS: Sponsor[] = [
  {
    name: "Anthropic",
    youtubeUrl: "https://www.youtube.com/watch?v=FDNkDBNR7AM",
    youtubeTitle: "Keep thinking with Claude",
    youtubeAuthor: "Anthropic",
    summary:
      "Anthropic is an AI safety and research company that builds the Claude family of AI models. It sells Claude to individuals and teams through claude.ai subscriptions and to developers and enterprises through the Claude API and Claude Code.",
    targetAudience: { software: 0.4, office: 0.3, startups: 0.2, students: 0.1 },
    dailyBudgetMinor: 450,
  },
  {
    name: "Coinbase",
    youtubeUrl: "https://www.youtube.com/watch?v=0V4CCxskN_0",
    youtubeTitle: "Your Way Out",
    youtubeAuthor: "Coinbase",
    summary:
      "Coinbase is a publicly traded US cryptocurrency exchange where retail users and institutions buy, sell, store and trade crypto assets. It also runs the Base blockchain and the Coinbase Developer Platform for builders creating onchain apps.",
    targetAudience: { investors: 0.5, finance: 0.2, software: 0.15, startups: 0.15 },
    dailyBudgetMinor: 400,
  },
  {
    name: "Convex",
    youtubeUrl: "https://www.youtube.com/watch?v=UVvd7BF99-4",
    youtubeTitle: "Intro to Convex",
    youtubeAuthor: "Convex",
    summary:
      "Convex is a reactive backend platform that combines a database, TypeScript server functions and real-time sync so app data updates live in clients. It is sold to developers and startups building full-stack web and AI apps, with a free tier and usage-based paid plans.",
    targetAudience: { software: 0.6, startups: 0.3, students: 0.1 },
    dailyBudgetMinor: 200,
  },
  {
    name: "Microsoft",
    youtubeUrl: "https://www.youtube.com/watch?v=c5dsS21bt04",
    youtubeTitle: "Microsoft Copilot: Work, transformed",
    youtubeAuthor: "Microsoft Copilot",
    summary:
      "Microsoft sells software, cloud and devices, including Windows, Microsoft 365, the Azure cloud platform and the Copilot AI assistant. Its customers range from consumers and students to developers and large enterprises.",
    targetAudience: { office: 0.5, software: 0.25, students: 0.15, families: 0.1 },
    dailyBudgetMinor: 500,
  },
  {
    name: "Fetch.ai",
    youtubeUrl: "https://www.youtube.com/watch?v=95k49sF7aG4",
    youtubeTitle: "Embrace the future of connectivity with Fetch.ai AI Agent technology",
    youtubeAuthor: "FetchAI",
    summary:
      "Fetch.ai builds an ecosystem for autonomous AI agents: the uAgents framework and Agentverse marketplace for developers, plus ASI:One, a personal AI that routes requests to brand agents. It targets developers and businesses building agents, and its FET token is part of the ASI Alliance.",
    targetAudience: { software: 0.45, investors: 0.3, startups: 0.25 },
    dailyBudgetMinor: 200,
  },
  {
    name: "CREAO",
    youtubeUrl: "https://www.youtube.com/watch?v=3c2uNDjWNeg",
    youtubeTitle: "Introducing CREAO: The Super Agent that delivers beyond the chat window.",
    youtubeAuthor: "Creao AI",
    summary:
      "CREAO is a no-code AI agent platform whose agents plug into existing tools, learn how a user operates and run recurring work around the clock. It is aimed at founders, creators, freelancers and small teams who want to automate their business without writing code.",
    targetAudience: { startups: 0.5, office: 0.3, students: 0.2 },
    dailyBudgetMinor: 100,
  },
  {
    name: "Capital One",
    youtubeUrl: "https://www.youtube.com/watch?v=qLielIlvHfY",
    youtubeTitle: "Venture X Card - Globe Hopping 3.0 :30 | Capital One",
    youtubeAuthor: "Capital One",
    summary:
      "Capital One is a major US bank known for credit cards such as the Venture X travel card, plus checking and savings accounts, auto loans and commercial banking. It serves consumers, travelers and small businesses, largely through digital channels.",
    targetAudience: { families: 0.35, tourists: 0.25, finance: 0.25, office: 0.15 },
    dailyBudgetMinor: 500,
  },
  {
    name: "Apify",
    youtubeUrl: "https://www.youtube.com/watch?v=jBzXXZpDkf4",
    youtubeTitle: "Every agent needs proper tools | Equip your AI on Apify",
    youtubeAuthor: "Apify",
    summary:
      "Apify is a web scraping and automation platform with a marketplace (Apify Store) of thousands of ready-to-run tools called Actors for extracting real-time web data. Developers, data teams and AI agents use it for lead generation, competitor tracking and feeding web data into apps.",
    targetAudience: { software: 0.55, startups: 0.3, office: 0.15 },
    dailyBudgetMinor: 200,
  },
  {
    name: "Cartesia",
    youtubeUrl: "https://www.youtube.com/watch?v=AR_wclNEUPM",
    youtubeTitle: "Introducing Multilingual Voices",
    youtubeAuthor: "Cartesia AI",
    summary:
      "Cartesia builds real-time voice AI: Sonic text-to-speech, Ink speech-to-text and a platform for production voice agents in dozens of languages. It sells via API to developers and enterprises building low-latency voice agents for things like customer support and call routing.",
    targetAudience: { software: 0.6, startups: 0.3, office: 0.1 },
    dailyBudgetMinor: 150,
  },
  {
    name: "Bright Data",
    youtubeUrl: "https://www.youtube.com/watch?v=GL7pSAXG_Zw",
    youtubeTitle: "Turning the Web Into AI-Ready Data for the Next Generation of AI",
    youtubeAuthor: "Bright Data",
    summary:
      "Bright Data provides web data infrastructure: proxy networks, scraping and search APIs, ready-made datasets and agent web access (including an MCP server). It serves over 50,000 organizations, from e-commerce and finance teams to AI labs that need public web data at scale.",
    targetAudience: { software: 0.5, office: 0.25, finance: 0.25 },
    dailyBudgetMinor: 300,
  },
  {
    name: "Visa",
    youtubeUrl: "https://www.youtube.com/watch?v=3O3vIysUaGs",
    youtubeTitle: "Prodigies",
    youtubeAuthor: "Visa Europe",
    summary:
      "Visa operates a global payments network connecting consumers, merchants, financial institutions and governments. Its products include consumer and commercial cards, checkout and tokenization services used in everyday retail and travel.",
    targetAudience: { families: 0.3, tourists: 0.25, finance: 0.25, office: 0.2 },
    dailyBudgetMinor: 500,
  },
  {
    name: "Supercell",
    youtubeUrl: "https://www.youtube.com/watch?v=aE10HERgL-4",
    youtubeTitle: "It's Clash Anime Season! Happy 12th Clashiversary!",
    youtubeAuthor: "Clash of Clans",
    summary:
      "Supercell is a Finnish game studio best known for Clash of Clans, Clash Royale, Hay Day, Boom Beach and Brawl Stars. It sells free-to-play mobile games to a global consumer audience with in-game purchases.",
    targetAudience: { students: 0.4, families: 0.3, tourists: 0.2, startups: 0.1 },
    dailyBudgetMinor: 350,
  },
  {
    name: "Meta",
    youtubeUrl: "https://www.youtube.com/watch?v=1oBPHKpj_zA",
    youtubeTitle: "Ray-Ban Meta Big Game | Art Collection",
    youtubeAuthor: "Ray-Ban | Meta",
    summary:
      "Meta builds social apps and AI products including Facebook, Instagram, WhatsApp, Meta AI and Ray-Ban Meta glasses. It sells advertising and devices to consumers and brands worldwide.",
    targetAudience: { students: 0.3, families: 0.25, office: 0.25, startups: 0.2 },
    dailyBudgetMinor: 450,
  },
  {
    name: "Spacetime",
    youtubeUrl: "https://www.youtube.com/watch?v=C7gJ_UxVnSk",
    youtubeTitle: "1000x faster than your database - SpacetimeDB 2.0",
    youtubeAuthor: "SpacetimeDB",
    summary:
      "Spacetime (Clockwork Labs) builds SpacetimeDB, a realtime backend and database for multiplayer games and web apps with TypeScript support and automatic client sync. It targets game and full-stack developers.",
    targetAudience: { software: 0.55, startups: 0.3, students: 0.15 },
    dailyBudgetMinor: 200,
  },
  {
    name: "Figma",
    youtubeUrl: "https://www.youtube.com/watch?v=n5gJgkO2Dg0",
    youtubeTitle: "Config 2024: Figma product launch keynote",
    youtubeAuthor: "Figma",
    summary:
      "Figma is a collaborative design platform for UI, prototyping, Dev Mode and Slides. It sells seats to product designers, developers and teams building software interfaces.",
    targetAudience: { software: 0.45, startups: 0.3, office: 0.15, students: 0.1 },
    dailyBudgetMinor: 250,
  },
  {
    name: "Elastic",
    youtubeUrl: "https://www.youtube.com/watch?v=ONQDBXNsyH0",
    youtubeTitle: "Elastic - The Search AI Company",
    youtubeAuthor: "Elastic",
    summary:
      "Elastic builds Search AI for search, observability and security. Enterprises and developers use Elasticsearch and related products to query large volumes of data and power AI applications.",
    targetAudience: { software: 0.5, office: 0.3, finance: 0.2 },
    dailyBudgetMinor: 300,
  },
  {
    name: "Atlassian",
    youtubeUrl: "https://www.youtube.com/watch?v=zkJI3-xXO2w",
    youtubeTitle: "Team '24 Announcements! AI-powered whiteboards and Confluence company hub",
    youtubeAuthor: "Atlassian Confluence",
    summary:
      "Atlassian sells team collaboration software including Jira, Confluence and related AI features. Its customers are software, IT and business teams that plan, track and share work.",
    targetAudience: { office: 0.45, software: 0.35, startups: 0.2 },
    dailyBudgetMinor: 350,
  },
  {
    name: "Hyphenate",
    posterTitle: "Finance that runs itself",
    posterAuthor: "Hyphenate",
    posterSourceUrl: "https://www.hyphenate.ai/",
    posterSvg: brandPosterSvg({
      name: "Hyphenate",
      tagline: "Finance that runs itself, so you can sprint ahead.",
      accent: "#FA6610",
      site: "hyphenate.ai",
    }),
    summary:
      "Hyphenate is an autonomous finance platform for the office of the CFO. It connects existing finance systems, learns company policies, and runs routine work with audit-ready trails, escalating judgment calls to people.",
    targetAudience: { finance: 0.45, office: 0.35, software: 0.2 },
    dailyBudgetMinor: 250,
  },
  {
    name: "Bitdeer AI",
    posterTitle: "One Cloud, Infinite Possibilities",
    posterAuthor: "Bitdeer AI",
    posterSourceUrl: "https://www.bitdeer.ai/",
    posterSvg: brandPosterSvg({
      name: "Bitdeer AI",
      tagline: "NVIDIA-powered AI cloud from development to deployment.",
      accent: "#36D0AC",
      site: "bitdeer.ai",
    }),
    summary:
      "Bitdeer AI is an NVIDIA-powered AI cloud platform for training, deploying and serving models. It offers GPU infrastructure, model APIs and agent capabilities for startups and enterprises.",
    targetAudience: { software: 0.5, startups: 0.3, office: 0.2 },
    dailyBudgetMinor: 300,
  },
];

/** Official sponsors intentionally not seeded until a usable creative exists. */
export const SPONSORS_SKIPPED = [
  "Annapurna Labs",
  "CRS",
  "Moss",
  "Factory",
  "Armadin",
  "Notability",
  "Mana",
  "SpaceXSI",
] as const;
