-- CreateTable
CREATE TABLE "Notifications" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "Message" TEXT NOT NULL,
    "Type" TEXT NOT NULL,
    "IsRead" BOOLEAN NOT NULL DEFAULT false,
    "CreatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE INDEX "Notifications_MerchantId_idx" ON "Notifications"("MerchantId");

-- CreateIndex
CREATE INDEX "Notifications_IsRead_idx" ON "Notifications"("IsRead");

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;
