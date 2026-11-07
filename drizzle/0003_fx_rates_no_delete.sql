-- Stored market rates can be neither changed nor removed, so history does not move.
DROP TRIGGER fx_rates_immutable ON fx_rates;
--> statement-breakpoint
CREATE TRIGGER fx_rates_immutable
  BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION lullet_forbid_change();
