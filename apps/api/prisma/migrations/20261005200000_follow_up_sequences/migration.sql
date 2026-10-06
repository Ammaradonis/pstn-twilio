-- AlterTable
ALTER TABLE "sheets_push_logs" ADD COLUMN     "row_data" JSONB,
ADD COLUMN     "sequence_step" INTEGER NOT NULL DEFAULT 1;

