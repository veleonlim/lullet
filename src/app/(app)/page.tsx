const upcoming = [
  { title: "Ledger", detail: "Every expense in the currency it was paid in." },
  { title: "Balances", detail: "Who owes whom, with the fewest transfers." },
  { title: "Telegram", detail: "Send a screenshot, confirm, done." },
] as const;

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <p className="text-sm font-medium text-accent">Switzerland and Italy</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Split the trip, not the friendship.
        </h1>
        <p className="max-w-prose text-base text-pretty text-muted">
          lullet keeps one shared ledger for four travellers. The foundation is in place; the
          screens below arrive slice by slice.
        </p>
      </section>

      <section aria-labelledby="coming-next" className="space-y-3">
        <h2 id="coming-next" className="text-sm font-medium tracking-wide text-muted uppercase">
          Coming next
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {upcoming.map((item) => (
            <li key={item.title} className="rounded-xl border border-border bg-surface p-4">
              <p className="font-medium">{item.title}</p>
              <p className="mt-1 text-sm text-muted">{item.detail}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
