-- CreateTable
CREATE TABLE "outbound_call_intents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "destination_e164" TEXT NOT NULL,
    "selected_caller_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "consumed_by_call_sid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_call_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_call_intents_identity_expires_at_idx" ON "outbound_call_intents"("identity", "expires_at");

-- CreateIndex
CREATE INDEX "outbound_call_intents_phone_number_id_created_at_idx" ON "outbound_call_intents"("phone_number_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outbound_call_intents_expires_at_idx" ON "outbound_call_intents"("expires_at");

-- CreateIndex
CREATE INDEX "outbound_call_intents_consumed_by_call_sid_idx" ON "outbound_call_intents"("consumed_by_call_sid");

-- AddForeignKey
ALTER TABLE "outbound_call_intents" ADD CONSTRAINT "outbound_call_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_call_intents" ADD CONSTRAINT "outbound_call_intents_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
