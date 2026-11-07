"use server";

import { redirect } from "next/navigation";
import { endSession } from "@/lib/auth/session";

export async function signOutAction(): Promise<never> {
  await endSession();
  redirect("/signin");
}
