"use client";

import Script from "next/script";

type SessionUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
};

type Props = {
  session: { user: SessionUser };
};

/**
 * Loads the main app (/) after Auth.js session is established.
 */
export default function AppShell({ session }: Props) {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__BRANDSTORY_SESSION__=${JSON.stringify(session)};`,
        }}
      />
      <div id="app" />
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"
        strategy="beforeInteractive"
      />
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
        strategy="beforeInteractive"
      />
      <Script src="/sc-app.js" strategy="afterInteractive" />
    </>
  );
}
