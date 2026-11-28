-- The Meta-ad email sequence.
--
-- meta_ad_evidence gains what the ad itself says (primary text, button,
-- landing domain) so the emails can quote the school's own ad. Rows stored
-- before this keep nulls until the worker uploads them again.
ALTER TABLE "meta_ad_evidence" ADD COLUMN "ad_text" TEXT;
ALTER TABLE "meta_ad_evidence" ADD COLUMN "ad_cta" TEXT;
ALTER TABLE "meta_ad_evidence" ADD COLUMN "ad_link" TEXT;

-- One 6-email sequence per school with Meta ad evidence, whether or not the
-- school was called or emailed before (see MetaAdOutreachService).
CREATE TABLE "meta_ad_outreach" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "sheet_id" INTEGER NOT NULL,
    "sheet_title" TEXT NOT NULL,
    "school_title" TEXT NOT NULL,
    "school_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING_EMAIL',
    "email_to" TEXT,
    "row_data" JSONB,
    "ad" JSONB NOT NULL,
    "profile" JSONB,
    "time_zone" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 1,
    "due_at" TIMESTAMP(3),
    "first_sent_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "emails_sent" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "check_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ad_outreach_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_ad_outreach_school_key" ON "meta_ad_outreach"("user_id", "spreadsheet_id", "sheet_id", "school_key");
CREATE INDEX "meta_ad_outreach_due_idx" ON "meta_ad_outreach"("status", "due_at");
CREATE INDEX "meta_ad_outreach_tab_idx" ON "meta_ad_outreach"("spreadsheet_id", "sheet_id");

ALTER TABLE "meta_ad_outreach" ADD CONSTRAINT "meta_ad_outreach_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
