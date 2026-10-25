import {
  ArrowRight,
  ArrowUpRight,
  ChartBar,
  Check,
  MapPin,
  MonitorPlay,
} from "@phosphor-icons/react";
import { Brand, PrimaryLink } from "./ui";

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
            <p className="demo-eyebrow">
              <span />
              Digital ads. Physical places.
            </p>
            <h1 id="hero-title">
              One click.
              <br />
              Out in the <span>real world.</span>
            </h1>
            <p className="demo-hero-lead">
              Get your ad onto local screens. Reach people where they already
              are.
            </p>
            <div className="demo-hero-actions">
              <PrimaryLink href="#/signin">Get your ad out there</PrimaryLink>
              <a href="#/demo" className="demo-text-link">
                See it in action <ArrowRight size={17} />
              </a>
            </div>
          </div>
          <div className="demo-hero-scene">
            <img
              className="demo-cafe-photo"
              src="/images/neighborhood-cafe.jpg"
              alt="A neighborhood café, one of the everyday places where customers discover local brands"
              width="1600"
              height="1057"
              fetchPriority="high"
            />
            <div className="demo-scene-shade" />
            <div
              className="demo-physical-screen"
              aria-label="Illustrative advertisement on a café display"
            >
              <div className="demo-coffee-ad">
                <span>GOLDEN GATE COFFEE CO.</span>
                <strong>
                  Your next
                  <br />
                  great idea
                  <br />
                  <em>starts here.</em>
                </strong>
                <div>
                  Cold brew. Around the corner.
                  <ArrowUpRight size={25} />
                </div>
              </div>
              <span className="demo-screen-brand">BILLBOARD OS</span>
            </div>
            <p className="demo-scene-caption">
              A small screen. A real-world connection.
              <span>Illustrative placement</span>
            </p>
          </div>
        </section>
        <section
          className="demo-how demo-container"
          aria-labelledby="how-heading"
        >
          <div className="demo-how-heading">
            <p className="demo-eyebrow">From your screen to theirs</p>
            <h2 id="how-heading">
              Less setup.
              <br />
              More showing up.
            </h2>
            <p>
              Your campaign, its displays, and the results.
              <br />
              Everything you need in one clear view.
            </p>
          </div>
          <div className="demo-steps">
            <div>
              <MapPin size={24} />
              <div>
                <h3>Pick your place</h3>
                <p>Find a screen in the city you want to reach.</p>
              </div>
              <span>01</span>
            </div>
            <div>
              <MonitorPlay size={24} />
              <div>
                <h3>Make it yours</h3>
                <p>Add your creative, choose your time, and book.</p>
              </div>
              <span>02</span>
            </div>
            <div>
              <ChartBar size={24} />
              <div>
                <h3>See what happens</h3>
                <p>Follow your bookings and confirmed ad plays.</p>
              </div>
              <span>03</span>
            </div>
          </div>
        </section>
        <section
          className="demo-bottom-cta demo-container"
          aria-labelledby="cta-heading"
        >
          <div>
            <div className="demo-cta-note">
              <Check size={17} /> Built for the places people go.
            </div>
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
