import { SPONSORS } from "./sponsors";

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
] as const;

export const COMPANY_KNOWLEDGE = FACTS.map(([name, category, stage, overviewUrl, overview, productUrl, product]) => {
  const sponsor = SPONSORS.find((s) => s.name === name)!;
  return {
    name,
    summary: `${overview} ${product}`,
    category,
    stage,
    audienceTags: sponsor.targetAudience,
    videoTitle: sponsor.youtubeTitle,
    passages: [
      { key: "overview", title: `${name} overview`, url: overviewUrl, text: overview, sourceKind: "official_site" as const, verifiedAt: Date.UTC(2026, 9, 24) },
      { key: "product", title: `${name} products`, url: productUrl, text: product, sourceKind: "official_site" as const, verifiedAt: Date.UTC(2026, 9, 24) },
      { key: "creative", title: `${name} official video`, url: sponsor.youtubeUrl,
        text: `The linked video is titled "${sponsor.youtubeTitle}" and is attributed to ${sponsor.youtubeAuthor}. Use it as creative context alongside the company's wider product profile.`,
        sourceKind: "official_video" as const, verifiedAt: Date.UTC(2026, 9, 24) },
    ],
  };
});
