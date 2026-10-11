-- Widen the email column on email_finder_rows to hold multiple addresses
-- comma-separated (e.g. "info@bjc.com, owner@school.com, team@bjc.com").
-- The old VARCHAR(254) limit only fits one RFC 5321 address; 2000 chars
-- comfortably holds ~10 addresses with room to spare.

ALTER TABLE "email_finder_rows"
  ALTER COLUMN "email" TYPE VARCHAR(2000);
