-- Evidence kinds are a closed list (D-81).
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_kind_check"
  CHECK ("kind" IN ('check_run', 'profile_snapshot', 'schema_snapshot', 'pipeline_run'));

-- The reference points at a record of another table, so no foreign key can
-- hold it; this trigger checks that the record exists in the same workspace.
CREATE FUNCTION evidence_check_reference() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (
      SELECT id, workspace_id FROM check_runs WHERE NEW.kind = 'check_run'
      UNION ALL
      SELECT id, workspace_id FROM profile_snapshots WHERE NEW.kind = 'profile_snapshot'
      UNION ALL
      SELECT id, workspace_id FROM schema_snapshots WHERE NEW.kind = 'schema_snapshot'
      UNION ALL
      SELECT id, workspace_id FROM pipeline_runs WHERE NEW.kind = 'pipeline_run'
    ) AS r
    WHERE r.id = NEW.reference_id AND r.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'evidence must reference an existing record of the same workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_reference
BEFORE INSERT ON "evidence"
FOR EACH ROW EXECUTE FUNCTION evidence_check_reference();

-- Evidence is never changed or deleted by a statement of its own (FR-09).
-- A cascade (an incident, dataset, or workspace is removed) runs inside the
-- foreign-key trigger, one level deeper than a direct statement, so it passes.
CREATE FUNCTION evidence_refuse_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'evidence is immutable';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_immutable
BEFORE UPDATE OR DELETE ON "evidence"
FOR EACH ROW EXECUTE FUNCTION evidence_refuse_change();
