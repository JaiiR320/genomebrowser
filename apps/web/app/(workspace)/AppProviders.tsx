"use client";

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { sessionIdSchema } from "@weng-lab/browser-server/protocol";
import { BrowserServer } from "../../browser/BrowserServer";
import { ServerQueryProvider } from "../../browser/serverQuery";
import { WorkspaceSkeleton } from "../../components/workspace/WorkspaceSkeleton";

// Browser stores initialize browser-only rendering resources. The provider stays mounted
// in the shared layout while Next swaps the page supplied as children.
const BrowserSessionProvider = dynamic(
  () => import("../../browser/BrowserSession").then((module) => module.BrowserSessionProvider),
  { ssr: false, loading: () => <WorkspaceSkeleton /> },
);

/** Opened when no session has been viewed yet. */
const defaultSessionId = "local";

export function AppProviders({
  endpoint = "/api",
  children,
}: {
  /** Browser-server prefix. Session reads and writes join their paths to it. */
  endpoint?: string;
  children: ReactNode;
}) {
  const sessionId = useCurrentSessionId();
  // The query cache outlives a session switch. A new id remounts only the stores below.
  return (
    <ServerQueryProvider endpoint={endpoint}>
      <BrowserSessionProvider key={sessionId}>
        <BrowserServer endpoint={endpoint} sessionId={sessionId}>
          {children}
        </BrowserServer>
      </BrowserSessionProvider>
    </ServerQueryProvider>
  );
}

/** The session in the URL, or the last one viewed while on pages without one, such as Settings. */
function useCurrentSessionId() {
  const params = useParams<{ sessionId?: string }>();
  // An invalid ID renders the not-found page; keep the current session instead of opening it.
  const sessionId = sessionIdSchema.safeParse(params.sessionId).success
    ? params.sessionId
    : undefined;
  const [lastSessionId, setLastSessionId] = useState(sessionId ?? defaultSessionId);
  if (sessionId && sessionId !== lastSessionId) setLastSessionId(sessionId);
  return sessionId ?? lastSessionId;
}
