-- Invariants Drizzle cannot express in the schema: cross-row totals, append-only
-- and immutable tables, and soft-delete-only tables. Hand written; keep in sync
-- with the rules documented in src/db/schema.

-- Payer amounts add up to the expense amount, and so do share amounts. Checked at
-- COMMIT (deferred) so an expense and its rows can be written in one transaction
-- in any order. A write that is not wrapped with all of its rows fails at commit.
CREATE FUNCTION lullet_assert_expense_totals(target uuid) RETURNS void AS $$
DECLARE
  expected bigint;
  payer_total numeric;
  share_total numeric;
BEGIN
  SELECT amount_minor INTO expected FROM expenses WHERE id = target;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO payer_total FROM expense_payers WHERE expense_id = target;
  SELECT COALESCE(SUM(amount_minor), 0) INTO share_total FROM expense_shares WHERE expense_id = target;
  IF payer_total <> expected THEN
    RAISE EXCEPTION 'expense % payers total % but the expense is %', target, payer_total, expected
      USING ERRCODE = 'check_violation', CONSTRAINT = 'expense_payers_total';
  END IF;
  IF share_total <> expected THEN
    RAISE EXCEPTION 'expense % shares total % but the expense is %', target, share_total, expected
      USING ERRCODE = 'check_violation', CONSTRAINT = 'expense_shares_total';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION lullet_check_expense_totals() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    PERFORM lullet_assert_expense_totals(NEW.id);
  ELSE
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM lullet_assert_expense_totals(NEW.expense_id);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      PERFORM lullet_assert_expense_totals(OLD.expense_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expenses_totals_check
  AFTER INSERT OR UPDATE OF amount_minor ON expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lullet_check_expense_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expense_payers_totals_check
  AFTER INSERT OR UPDATE OR DELETE ON expense_payers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lullet_check_expense_totals();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expense_shares_totals_check
  AFTER INSERT OR UPDATE OR DELETE ON expense_shares
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lullet_check_expense_totals();
--> statement-breakpoint

-- Soft deletes: ledger rows are marked deleted (deleted_at, deleted_by), never removed.
CREATE FUNCTION lullet_forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are soft deleted by setting deleted_at, never removed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER expenses_no_hard_delete
  BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION lullet_forbid_delete();
--> statement-breakpoint
CREATE TRIGGER settlements_no_hard_delete
  BEFORE DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION lullet_forbid_delete();
--> statement-breakpoint

-- The audit log is append-only.
CREATE FUNCTION lullet_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION lullet_forbid_change();
--> statement-breakpoint

-- Stored market rates never change, so history does not move when the market does.
CREATE TRIGGER fx_rates_immutable
  BEFORE UPDATE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION lullet_forbid_change();
