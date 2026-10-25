import {
  ArrowRight,
  ArrowUpRight,
  ChartBar,
  MapPin,
  MonitorPlay,
} from "@phosphor-icons/react";
import { PROOF_LOGOS, ProofLogo } from "./ProofLogos";
import { Brand, PrimaryLink } from "./ui";

const STEPS = [
  {
    icon: MapPin,
    title: "Pick your place",
    body: "Find a screen in the city you want to reach.",
  },
  {
    icon: MonitorPlay,
    title: "Make it yours",
    body: "Add your creative, choose your time, and book.",
  },
  {
    icon: ChartBar,
    title: "See what happens",
    body: "Follow your bookings and confirmed ad plays.",
  },
] as const;

function LogoMarquee() {
  // Two identical groups → translateX(-50%) loops seamlessly.
  const groups = [0, 1] as const;
  return (
    <div className="demo-proof" aria-label="Brands already on local screens">
      <p className="demo-proof-label">On screens for</p>
      <ul className="sr-only">
        {PROOF_LOGOS.map(({ name }) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <div className="demo-proof-viewport" aria-hidden="true">
        <div className="demo-proof-track">
          {groups.map((group) => (
            <div key={group} className="demo-proof-group">
              {PROOF_LOGOS.map(({ name, src, width }) => (
                <span key={`${group}-${name}`} className="demo-proof-logo">
                  <ProofLogo name="" src={src} width={width} />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="demo-site">
      <header className="demo-site-header demo-container">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#/demo">
            Explore the demo <ArrowUpRight size={15} />
          </a>
          <a className="demo-button demo-button-small" href="#/signin">
            Open dashboard <ArrowRight size={16} />
          </a>
        </nav>
      </header>
      <main>
        <section
          className="demo-hero demo-container"
          aria-labelledby="hero-title"
        >
          <div className="demo-hero-copy fade-in">
            <h1 id="hero-title">
              One click.
              <br />
              Out in the <span>real world.</span>
            </h1>
            <p className="demo-hero-lead">
              Get your ad onto local screens. Reach people where they already
              are.
            </p>
            <LogoMarquee />
            <div className="demo-hero-actions">
              <PrimaryLink href="#/signin">Get your ad out there</PrimaryLink>
              <a href="#/demo" className="demo-text-link">
                See it in action <ArrowRight size={17} />
              </a>
            </div>
          </div>

          <div className="demo-hero-visual">
            <div className="demo-hero-scene">
              <img
                className="demo-cafe-photo"
                src="/images/billboard-cafe-real.jpg"
                alt="A BillboardOS screen in a café showing a live Golden Gate Coffee ad"
                width="1600"
                height="900"
                fetchPriority="high"
              />
            </div>
          </div>
        </section>

        <section
          className="demo-how demo-container"
          aria-labelledby="how-heading"
        >
          <div className="demo-how-heading">
            <h2 id="how-heading">Make your company known in 3 steps:</h2>
          </div>
          <div className="demo-steps">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              return (
                <div key={step.title} className="demo-step">
                  <span className="demo-step-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <Icon size={28} weight="regular" aria-hidden="true" />
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section
          className="demo-bottom-cta demo-container"
          aria-labelledby="cta-heading"
        >
          <div>
            <h2 id="cta-heading">
              Meet your next customer.
              <br />
              <span>Out there.</span>
            </h2>
          </div>
          <PrimaryLink href="#/signin">Start your first campaign</PrimaryLink>
        </section>
      </main>
      <footer className="demo-footer demo-container">
        <Brand />
        <span>Local screens. Real connections.</span>
        <a href="#/signin">
          Have a screen? Become a host <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}
