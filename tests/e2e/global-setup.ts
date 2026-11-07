import { prepareDatabase } from "./support/database";

export default async function globalSetup(): Promise<void> {
  await prepareDatabase();
}
