import { json, withImports } from "@/server/import/http";
import { notifyAfterResponse } from "@/server/telegram/runtime";

export const dynamic = "force-dynamic";

/** Reverse a confirmed import: its expenses are soft deleted together (uploader only). */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withImports(request, { write: true }, async ({ store }) => {
    const { id } = await context.params;
    const result = await store.undo(id);
    if (result.expenseIds.length > 0) {
      const { userId, groupId } = store.session;
      const view = await store.getDraft(id);
      // Members who shared in the removed expenses hear about it (decision D6).
      if (view)
        notifyAfterResponse((bot) =>
          bot.importUndone(
            groupId,
            userId,
            view.expenses.filter((e) => result.expenseIds.includes(e.id)),
          ),
        );
    }
    return json(result);
  });
}
