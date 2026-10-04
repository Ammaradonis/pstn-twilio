-- How the email finder found each address (shown in the Dial page notifications).
ALTER TABLE "email_finder_rows" ADD COLUMN "method" TEXT;
