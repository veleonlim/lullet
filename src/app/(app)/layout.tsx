import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth/session";

/** Every page in this group needs a live session; anyone else is sent to the sign-in page. */
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return children;
}
