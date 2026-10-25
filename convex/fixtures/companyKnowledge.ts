import { SPONSORS, isPosterSponsor, sponsorCreativeAuthor, sponsorCreativeTitle } from "./sponsors";

/** Public facts only. Sponsor campaigns, budgets and wallets are simulated elsewhere. */
const FACTS = [
  ["Anthropic", "ai models", "enterprise", "https://www.anthropic.com/claude/api", "Anthropic offers Claude models through an API for developers building AI applications. Its developer offering includes model access and documentation for integrating Claude into products and workflows.", "https://claude.com/product/overview", "Claude is an AI assistant used for writing, analysis, coding and workplace tasks. The product is available directly to individuals and through organization plans."],
  ["Coinbase", "crypto exchange", "enterprise", "https://www.coinbase.com/", "Coinbase offers cryptocurrency trading and related services to individuals, businesses and institutions. Its offerings include trading, custody, payments and onchain access.", "https://www.coinbase.com/developer-platform", "Coinbase Developer Platform provides tools and infrastructure for developers building onchain applications. This developer audience is distinct from the consumer trading audience."],
  ["Convex", "developer tools", "growth", "https://www.convex.dev/", "Convex combines a database, TypeScript server functions, synchronization, search and file storage in a reactive backend. It is positioned for teams building interactive web and AI applications.", "https://docs.convex.dev/", "Convex developer documentation covers queries, mutations, actions and realtime client updates. These features serve software developers building full-stack applications."],
  ["Microsoft", "software and cloud", "enterprise", "https://www.microsoft.com/", "Microsoft offers software, devices and cloud services for people and organizations. Its portfolio spans workplace productivity, developer tools and infrastructure.", "https://www.microsoft.com/en-us/copilot", "Microsoft Copilot connects workplace content and apps with AI models to help produce work. The product is aimed at people and teams using Microsoft tools for everyday tasks."],
  ["Fetch.ai", "ai agent infrastructure", "growth", "https://www.fetch.ai/docs", "Fetch.ai provides a developer platform for building, registering and discovering AI agents. Its documentation introduces ASI:One, Agentverse and uAgents as parts of its ecosystem.", "https://uagents.fetch.ai/docs", "The uAgents framework supports developer-created agents, while Agentverse provides discovery and hosting paths. The documentation addresses builders who want agents to communicate and perform tasks."],
  ["CREAO", "ai agent platform", "growth", "https://creao.ai/", "CREAO builds agents that run recurring work in tools a business already uses. The platform presents them as ongoing workers that accumulate operational knowledge and can run on schedules.", "https://creao.ai/", "CREAO's examples include handling quotes, preparing ads and monitoring inventory. These examples position the product for teams automating operational workflows."],
  ["Capital One", "financial services", "enterprise", "https://www.capitalone.com/", "Capital One offers credit cards, checking, savings, auto financing and business banking. Its consumer and business lines address distinct financial needs.", "https://www.capitalone.com/credit-cards/", "Capital One groups credit cards into travel, cash back, student, business and other categories. A travel-card creative is a specific product message within that wider portfolio."],
  ["Apify", "web data", "growth", "https://apify.com/", "Apify offers ready-to-run tools for obtaining web data, monitoring competitors, generating leads and integrating applications. Its marketplace presents these tools to developers and AI builders.", "https://docs.apify.com/actors", "Apify Actors are serverless programs that accept structured inputs and run tasks such as scraping, browser automation and data processing. They can run through a console, API, CLI or schedule."],
  ["Cartesia", "voice ai", "growth", "https://www.cartesia.ai/", "Cartesia offers real-time speech models and voice agents through an API intended for live conversation. Its platform combines speech generation and recognition with agent capabilities.", "https://www.cartesia.ai/", "Cartesia lists Sonic text-to-speech, Ink speech-to-text and managed voice agents. The product set serves builders creating interactive voice experiences."],
  ["Bright Data", "web data", "enterprise", "https://brightdata.com/", "Bright Data offers web access APIs, data feeds, datasets and proxy services. It positions its platform as web data infrastructure for people and AI agents.", "https://brightdata.com/products", "Bright Data product lines include Scraper APIs, SERP API, Browser API and pre-collected datasets. These tools serve teams that need public web information at scale."],
  ["Visa", "payments", "enterprise", "https://usa.visa.com/", "Visa operates a global payments network connecting consumers, merchants and financial institutions. Its products support everyday retail, travel and digital checkout.", "https://usa.visa.com/pay-with-visa.html", "Visa consumer and commercial payment products are used worldwide for card and digital transactions."],
  ["Supercell", "games", "enterprise", "https://supercell.com/", "Supercell is a Finnish game studio known for Clash of Clans, Clash Royale, Hay Day, Boom Beach and Brawl Stars. It sells free-to-play mobile games with in-game purchases.", "https://supercell.com/en/games/", "Supercell's live games target a global mobile audience with ongoing seasonal content and events."],
  ["Meta", "social and ai", "enterprise", "https://about.meta.com/", "Meta builds social apps and AI products including Facebook, Instagram, WhatsApp, Meta AI and Ray-Ban Meta glasses. It sells advertising and devices to consumers and brands.", "https://www.meta.com/ai-glasses/", "Ray-Ban Meta glasses combine wearable cameras and Meta AI for on-device assistance and capture."],
  ["Spacetime", "developer tools", "growth", "https://spacetimedb.com/", "Spacetime (Clockwork Labs) builds SpacetimeDB, a realtime backend and database for multiplayer games and web apps with TypeScript support and automatic client sync.", "https://spacetimedb.com/", "SpacetimeDB targets game and full-stack developers who need persistence, logic and realtime sync in one backend."],
  ["Figma", "design tools", "enterprise", "https://www.figma.com/", "Figma is a collaborative design platform for UI, prototyping, Dev Mode and Slides. It sells seats to product designers, developers and software teams.", "https://www.figma.com/dev-mode/", "Figma Dev Mode and related tools help designers and engineers hand off interface work more accurately."],
  ["Elastic", "search ai", "enterprise", "https://www.elastic.co/", "Elastic builds Search AI for search, observability and security. Enterprises and developers use Elasticsearch and related products to query large volumes of data.", "https://www.elastic.co/elastic-search-ai", "Elastic Search AI products help teams retrieve, observe and secure data with AI-assisted workflows."],
  ["Atlassian", "team collaboration", "enterprise", "https://www.atlassian.com/", "Atlassian sells team collaboration software including Jira, Confluence and related AI features. Its customers are software, IT and business teams that plan and track work.", "https://www.atlassian.com/software/confluence", "Confluence and Jira are used together for planning, documentation and delivery across product organizations."],
  ["Hyphenate", "autonomous finance", "growth", "https://www.hyphenate.ai/", "Hyphenate is an autonomous finance platform for the office of the CFO. It connects existing finance systems and runs routine work with audit-ready trails.", "https://www.hyphenate.ai/", "Hyphenate agents handle order-to-cash, treasury, GL, procure-to-pay and reporting, escalating judgment calls to people when needed."],
  ["Bitdeer AI", "ai cloud", "enterprise", "https://www.bitdeer.ai/", "Bitdeer AI is an NVIDIA-powered AI cloud platform for the full AI lifecycle from development to deployment.", "https://developers.bitdeer.ai/", "Bitdeer AI offers GPU infrastructure, serverless model APIs and agent capabilities for builders and enterprises."],
] as const;

export const COMPANY_KNOWLEDGE = FACTS.map(([name, category, stage, overviewUrl, overview, productUrl, product]) => {
  const sponsor = SPONSORS.find((s) => s.name === name)!;
  const creativeTitle = sponsorCreativeTitle(sponsor);
  const creativeAuthor = sponsorCreativeAuthor(sponsor);
  const creativeUrl = isPosterSponsor(sponsor)
    ? (sponsor.posterSourceUrl ?? overviewUrl)
    : sponsor.youtubeUrl!;
  const creativeKind = isPosterSponsor(sponsor) ? ("official_site" as const) : ("official_video" as const);
  const creativeLabel = isPosterSponsor(sponsor) ? "brand poster" : "official video";
  return {
    name,
    summary: `${overview} ${product}`,
    category,
    stage,
    audienceTags: sponsor.targetAudience,
    videoTitle: creativeTitle,
    passages: [
      { key: "overview", title: `${name} overview`, url: overviewUrl, text: overview, sourceKind: "official_site" as const, verifiedAt: Date.UTC(2026, 9, 24) },
      { key: "product", title: `${name} products`, url: productUrl, text: product, sourceKind: "official_site" as const, verifiedAt: Date.UTC(2026, 9, 24) },
      { key: "creative", title: `${name} ${creativeLabel}`, url: creativeUrl,
        text: isPosterSponsor(sponsor)
          ? `The brand poster is titled "${creativeTitle}" and attributed to ${creativeAuthor}, derived from public brand identity at ${creativeUrl}. Use it as creative context alongside the company's wider product profile.`
          : `The linked video is titled "${creativeTitle}" and is attributed to ${creativeAuthor}. Use it as creative context alongside the company's wider product profile.`,
        sourceKind: creativeKind, verifiedAt: Date.UTC(2026, 9, 24) },
    ],
  };
});
