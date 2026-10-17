-- One GitHub issue per incident: GitHub destinations hear about openings only (D-96).
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_github_events_check"
  CHECK ("type" <> 'github' OR "events" = ARRAY['incident_opened']);
