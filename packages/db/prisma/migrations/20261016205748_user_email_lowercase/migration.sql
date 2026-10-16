-- Emails are stored lowercase so uniqueness is case-insensitive (docs/03).
-- The application normalizes; this constraint catches any path that forgets.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
