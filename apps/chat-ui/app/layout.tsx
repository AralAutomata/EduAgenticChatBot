import "./globals.css";

/**
 * Next.js App Router root layout.
 *
 * Why this is minimal:
 * - The demo UI is a single-page experience (`app/page.tsx`), so the layout simply applies global CSS
 *   and provides document-level metadata.
 */
export const metadata = {
  title: "EduAgent Chat",
  description: "Chat interface for the educational assistant agent"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Keep layout simple: styling and structure are handled in the page itself. */}
      <body>{children}</body>
    </html>
  );
}
