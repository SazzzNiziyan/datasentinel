-- What an integration may ever be sent (D-97): a notification payload is an
-- object holding only title, severity, and datasetName. Anything else (a row
-- value, a secret, a stray field) is refused by the database itself.
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_payload_allowlist_check"
  CHECK (jsonb_typeof("payload") = 'object'
    AND ("payload" - ARRAY['title', 'severity', 'datasetName']) = '{}'::jsonb);

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_payload_allowlist_check"
  CHECK (jsonb_typeof("payload") = 'object'
    AND ("payload" - ARRAY['title', 'severity', 'datasetName']) = '{}'::jsonb);
