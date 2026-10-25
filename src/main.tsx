import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

// The Convex URL is public. Keep this fallback so collaborators can clone the
// repo and use the shared deployment without receiving a local secret file.
const convexUrl = import.meta.env.VITE_CONVEX_URL || "https://lovable-cricket-727.convex.cloud";
const convex = new ConvexReactClient(convexUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
