-- CreateTable
CREATE TABLE "sms_campaigns" (
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "daily_cap" INTEGER NOT NULL DEFAULT 100,
    "started_at" TIMESTAMP(3),
    "last_send_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_campaigns_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sms_campaign_sends" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "to_e164" TEXT NOT NULL,
    "push_log_id" TEXT,
    "school_name" TEXT,
    "status" TEXT NOT NULL,
    "sms_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sms_campaign_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sms_campaign_sends_sms_message_id_key" ON "sms_campaign_sends"("sms_message_id");

-- CreateIndex
CREATE INDEX "sms_campaign_sends_user_id_created_at_idx" ON "sms_campaign_sends"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sms_campaign_sends_user_id_to_e164_key" ON "sms_campaign_sends"("user_id", "to_e164");

-- AddForeignKey
ALTER TABLE "sms_campaigns" ADD CONSTRAINT "sms_campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_campaign_sends" ADD CONSTRAINT "sms_campaign_sends_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_campaign_sends" ADD CONSTRAINT "sms_campaign_sends_sms_message_id_fkey" FOREIGN KEY ("sms_message_id") REFERENCES "sms_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

