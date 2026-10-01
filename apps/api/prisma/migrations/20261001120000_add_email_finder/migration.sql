-- AlterTable
ALTER TABLE "sheets_push_logs" ADD COLUMN     "contact_form_url" TEXT;

-- CreateTable
CREATE TABLE "email_finder_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "sheet_title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "email_finder_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_finder_rows" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "email" TEXT,
    "email_type" TEXT,
    "confidence" INTEGER,
    "source_url" TEXT,
    "decision_maker" TEXT,
    "contact_form_url" TEXT,
    "notes" TEXT,
    "written_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_finder_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_finder_jobs_user_id_spreadsheet_id_sheet_title_key" ON "email_finder_jobs"("user_id", "spreadsheet_id", "sheet_title");

-- CreateIndex
CREATE INDEX "email_finder_rows_job_id_status_idx" ON "email_finder_rows"("job_id", "status");

-- CreateIndex
CREATE INDEX "email_finder_rows_status_claimed_at_idx" ON "email_finder_rows"("status", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_finder_rows_job_id_fingerprint_key" ON "email_finder_rows"("job_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "email_finder_jobs" ADD CONSTRAINT "email_finder_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_finder_rows" ADD CONSTRAINT "email_finder_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "email_finder_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

