-- Integration tokens expire (D-95). Tokens issued before this have no expiry;
-- administrators can revoke and reissue them.
ALTER TABLE "integration_tokens" ADD COLUMN "expires_at" TIMESTAMPTZ(3);
