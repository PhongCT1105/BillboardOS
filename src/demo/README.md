# Simplified frontend demo

- `#/` is the public landing page.
- `#/demo` is an interactive preview with explicitly labeled sample data. It does not create an account or make bookings.
- `#/signin` uses the existing sign-in and automatic setup flow.
- `#/customer` opens the advertiser overview, with Displays and Campaigns as the main sections.
- `#/console` opens the host overview. Operational tools remain available in an expandable section.

Signed-in views use existing Convex queries. Display previews do not record playback; opening the actual player retains the existing behavior.

This frontend change integrates through `src/App.tsx`, `src/lib/hooks.ts`, `src/customer/CustomerPage.tsx`, and `src/console/ConsolePage.tsx`. It does not modify Convex files, `src/auth/AutoSetup.tsx`, or `src/customer/AgentSetupPanel.tsx`, which were already being edited by another agent. No dependency changes are needed.

The local café photograph comes from [Unsplash](https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb). The orange advertisement is an illustrative placement, not an actual customer claim. Sample preview artwork reuses the existing `public/demo-creatives/golden-gate-coffee.svg`.
