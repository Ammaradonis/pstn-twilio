-- Enrichment mode: a tab can run the address hunt and the social-column
-- enrichment independently, so the job identity gains a mode.
--
-- Existing jobs become mode 'EMAIL', which is what they were.
ALTER TABLE "email_finder_jobs" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'EMAIL';

-- One tab had at most one job; now it has at most one per mode.
DROP INDEX "email_finder_jobs_user_id_spreadsheet_id_sheet_title_key";

CREATE UNIQUE INDEX "email_finder_jobs_user_id_spreadsheet_id_sheet_title_mode_key" ON "email_finder_jobs"("user_id", "spreadsheet_id", "sheet_title", "mode");
