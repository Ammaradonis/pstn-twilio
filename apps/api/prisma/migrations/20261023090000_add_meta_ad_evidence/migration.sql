-- Meta advertising evidence: one row per (tab, school, ad) pair the worker
-- verified in facebook.com/ads/library. The worker re-sends a tab's full result
-- set, so the API replaces that tab's rows on every upload.
--
-- `sheet_id` is the key (tab titles change); `row_index` is only a hint because
-- the tab may be sorted between the match and the button press. "Running now"
-- is decided by `observed_at` being recent, not by the ad's start date.
CREATE TABLE "meta_ad_evidence" (
    "id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "sheet_id" INTEGER NOT NULL,
    "sheet_title" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "school_title" TEXT NOT NULL,
    "facebook_url" TEXT NOT NULL,
    "advertiser_name" TEXT NOT NULL,
    "advertiser_url" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_ad_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_ad_evidence_school_ad_key" ON "meta_ad_evidence"("spreadsheet_id", "sheet_id", "ad_id", "school_title");
CREATE INDEX "meta_ad_evidence_tab_status_idx" ON "meta_ad_evidence"("spreadsheet_id", "sheet_id", "status", "observed_at");
