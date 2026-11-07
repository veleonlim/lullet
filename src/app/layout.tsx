import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { getCurrentMember } from "@/lib/auth/session";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "lullet",
    template: "%s | lullet",
  },
  description: "Shared expenses for four, built for the road through Switzerland and Italy.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf6" },
    { media: "(prefers-color-scheme: dark)", color: "#1b2330" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const member = await getCurrentMember();
  return (
    <html lang="en">
      <body>
        <AppShell member={member}>{children}</AppShell>
      </body>
    </html>
  );
}
