-- CreateTable
CREATE TABLE "google_sheets_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "google_email" TEXT,
    "refresh_token_encrypted" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_sheets_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheets_push_logs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "sheet_title" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "destination_e164" TEXT NOT NULL,
    "caller_e164" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "custom_note" TEXT,
    "cell_value" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "school_name" TEXT,
    "email_status" TEXT NOT NULL DEFAULT 'NONE',
    "email_to" TEXT,
    "email_template" TEXT,
    "email_due_at" TIMESTAMP(3),
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_error" TEXT,
    "email_sent_at" TIMESTAMP(3),
    "call_ended_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sheets_push_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_sheets_connections_user_id_key" ON "google_sheets_connections"("user_id");

-- CreateIndex
CREATE INDEX "sheets_push_logs_connection_id_created_at_idx" ON "sheets_push_logs"("connection_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sheets_push_logs_connection_id_destination_e164_idx" ON "sheets_push_logs"("connection_id", "destination_e164");

-- CreateIndex
CREATE INDEX "sheets_push_logs_email_status_email_due_at_idx" ON "sheets_push_logs"("email_status", "email_due_at");

-- AddForeignKey
ALTER TABLE "google_sheets_connections" ADD CONSTRAINT "google_sheets_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheets_push_logs" ADD CONSTRAINT "sheets_push_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "google_sheets_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

