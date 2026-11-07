import type { Metadata } from "next";
import { ImportUploader } from "@/components/import/uploader";
import { PageHeader } from "@/components/ui";
import { openImportStore } from "@/server/import/runtime";

export const metadata: Metadata = { title: "Import screenshot" };

export default async function NewImportPage() {
  await openImportStore();
  return (
    <>
      <PageHeader title="Import a screenshot" back={{ href: "/expenses", label: "Expenses" }} />
      <ImportUploader />
    </>
  );
}
