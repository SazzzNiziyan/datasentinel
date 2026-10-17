-- An archived destination keeps no secret (D-94): it can never send again.
UPDATE "destinations" SET "ciphertext" = NULL, "key_version" = NULL WHERE "status" = 'archived';

ALTER TABLE "destinations" DROP CONSTRAINT "destinations_secret_required_check";
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_secret_required_check"
  CHECK ("type" = 'email' OR "status" = 'archived' OR "ciphertext" IS NOT NULL);
