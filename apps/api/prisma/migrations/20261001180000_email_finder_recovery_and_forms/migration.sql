ALTER TABLE "email_finder_rows"
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "research_complete" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "email_finder_rows_status_next_attempt_at_idx"
  ON "email_finder_rows"("status", "next_attempt_at");
ALTER TABLE "sheets_push_logs" ADD COLUMN "form_lease_token" TEXT;
