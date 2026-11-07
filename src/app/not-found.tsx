import { ButtonLink, Card } from "@/components/ui";

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-md space-y-3 p-6 text-center">
      <h1 className="text-xl font-semibold">We could not find that</h1>
      <p className="text-sm text-muted">
        It may have been removed, or the link is not quite right.
      </p>
      <ButtonLink href="/expenses" variant="primary">
        Back to expenses
      </ButtonLink>
    </Card>
  );
}
