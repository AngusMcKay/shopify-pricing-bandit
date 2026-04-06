-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchants" (
    "MerchantId" TEXT NOT NULL,
    "ShopifyAccessToken" TEXT NOT NULL,
    "InstalledAt" TIMESTAMP(3) NOT NULL,
    "PlanTier" TEXT,
    "IsActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Merchants_pkey" PRIMARY KEY ("MerchantId")
);

-- CreateTable
CREATE TABLE "ExperimentMerchantInputs" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "VariantId" TEXT NOT NULL,
    "ExperimentParameter" TEXT NOT NULL,
    "ExperimentParameterValue" TEXT NOT NULL,

    CONSTRAINT "ExperimentMerchantInputs_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "ExperimentMerchantProductSnapshot" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "ProductTitle" TEXT NOT NULL,
    "ProductStatus" TEXT NOT NULL,
    "VariantId" TEXT NOT NULL,
    "VariantTitle" TEXT NOT NULL,
    "VariantPrice" DECIMAL(65,30) NOT NULL,
    "VariantCompareAtPrice" DECIMAL(65,30),
    "VariantInventoryQuantity" INTEGER,
    "VariantInventoryPolicy" TEXT NOT NULL,
    "VariantSKU" TEXT,

    CONSTRAINT "ExperimentMerchantProductSnapshot_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "ExperimentSetup" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "BaseVariantId" TEXT NOT NULL,
    "ExperimentVariantId" TEXT NOT NULL,
    "ExperimentSubset" TEXT,
    "Price" DECIMAL(65,30) NOT NULL,
    "Probability" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "ExperimentSetup_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "ExperimentLive" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "Status" TEXT NOT NULL,
    "LastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExperimentLive_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "ExperimentSubsets" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "Subset" TEXT NOT NULL,
    "SubsetParameter" TEXT NOT NULL,
    "SubsetParameterValue" TEXT NOT NULL,

    CONSTRAINT "ExperimentSubsets_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "Impressions" (
    "Id" SERIAL NOT NULL,
    "CookieId" TEXT NOT NULL,
    "SessionId" TEXT NOT NULL,
    "Datetime" TIMESTAMP(3) NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "ExperimentVariantId" TEXT NOT NULL,
    "ExperimentSubset" TEXT,
    "Price" DECIMAL(65,30) NOT NULL,
    "Currency" TEXT NOT NULL,
    "Market" TEXT,
    "Country" TEXT,
    "DeviceType" TEXT NOT NULL,
    "TrafficSource" TEXT,
    "ReferrerURL" TEXT,
    "UserAgent" TEXT,
    "IsNewVisitor" BOOLEAN NOT NULL,

    CONSTRAINT "Impressions_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "Purchases" (
    "Id" SERIAL NOT NULL,
    "CookieId" TEXT,
    "SessionId" TEXT,
    "Datetime" TIMESTAMP(3) NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "ExperimentVariantId" TEXT NOT NULL,
    "ExperimentSubset" TEXT,
    "Price" DECIMAL(65,30) NOT NULL,
    "Currency" TEXT NOT NULL,
    "Market" TEXT,
    "Country" TEXT,
    "DeviceType" TEXT,
    "TrafficSource" TEXT,
    "OrderId" TEXT NOT NULL,
    "OrderValue" DECIMAL(65,30) NOT NULL,
    "IsFirstPurchase" BOOLEAN NOT NULL,
    "DiscountApplied" BOOLEAN NOT NULL,

    CONSTRAINT "Purchases_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "BanditParameters" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "ExperimentVariantId" TEXT NOT NULL,
    "ExperimentSubset" TEXT,
    "Price" DECIMAL(65,30) NOT NULL,
    "ContextualParameter" TEXT NOT NULL,
    "ContextualParameterMean" DECIMAL(65,30) NOT NULL,
    "ContextualParameterVariance" DECIMAL(65,30) NOT NULL,
    "TotalImpressions" INTEGER NOT NULL,
    "TotalPurchases" INTEGER NOT NULL,
    "ModelVersion" INTEGER NOT NULL DEFAULT 0,
    "DatetimeUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BanditParameters_pkey" PRIMARY KEY ("Id")
);

-- CreateTable
CREATE TABLE "BanditParametersHistory" (
    "Id" SERIAL NOT NULL,
    "MerchantId" TEXT NOT NULL,
    "ExperimentDatetimeSubmitted" TIMESTAMP(3) NOT NULL,
    "ProductId" TEXT NOT NULL,
    "ExperimentVariantId" TEXT NOT NULL,
    "ExperimentSubset" TEXT,
    "Price" DECIMAL(65,30) NOT NULL,
    "ContextualParameter" TEXT NOT NULL,
    "ContextualParameterMean" DECIMAL(65,30) NOT NULL,
    "ContextualParameterVariance" DECIMAL(65,30) NOT NULL,
    "TotalImpressions" INTEGER NOT NULL,
    "TotalPurchases" INTEGER NOT NULL,
    "ModelVersion" INTEGER NOT NULL,
    "DatetimeUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BanditParametersHistory_pkey" PRIMARY KEY ("Id")
);

-- CreateIndex
CREATE INDEX "ExperimentMerchantInputs_MerchantId_idx" ON "ExperimentMerchantInputs"("MerchantId");

-- CreateIndex
CREATE INDEX "ExperimentMerchantInputs_ExperimentDatetimeSubmitted_idx" ON "ExperimentMerchantInputs"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "ExperimentMerchantProductSnapshot_MerchantId_idx" ON "ExperimentMerchantProductSnapshot"("MerchantId");

-- CreateIndex
CREATE INDEX "ExperimentMerchantProductSnapshot_ExperimentDatetimeSubmitt_idx" ON "ExperimentMerchantProductSnapshot"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "ExperimentSetup_MerchantId_idx" ON "ExperimentSetup"("MerchantId");

-- CreateIndex
CREATE INDEX "ExperimentSetup_ExperimentDatetimeSubmitted_idx" ON "ExperimentSetup"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "ExperimentLive_MerchantId_idx" ON "ExperimentLive"("MerchantId");

-- CreateIndex
CREATE INDEX "ExperimentLive_ExperimentDatetimeSubmitted_idx" ON "ExperimentLive"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "ExperimentSubsets_MerchantId_idx" ON "ExperimentSubsets"("MerchantId");

-- CreateIndex
CREATE INDEX "ExperimentSubsets_ExperimentDatetimeSubmitted_idx" ON "ExperimentSubsets"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "Impressions_MerchantId_idx" ON "Impressions"("MerchantId");

-- CreateIndex
CREATE INDEX "Impressions_CookieId_idx" ON "Impressions"("CookieId");

-- CreateIndex
CREATE INDEX "Impressions_ExperimentDatetimeSubmitted_idx" ON "Impressions"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE UNIQUE INDEX "Purchases_OrderId_key" ON "Purchases"("OrderId");

-- CreateIndex
CREATE INDEX "Purchases_MerchantId_idx" ON "Purchases"("MerchantId");

-- CreateIndex
CREATE INDEX "Purchases_CookieId_idx" ON "Purchases"("CookieId");

-- CreateIndex
CREATE INDEX "Purchases_ExperimentDatetimeSubmitted_idx" ON "Purchases"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "BanditParameters_MerchantId_idx" ON "BanditParameters"("MerchantId");

-- CreateIndex
CREATE INDEX "BanditParameters_ExperimentDatetimeSubmitted_idx" ON "BanditParameters"("ExperimentDatetimeSubmitted");

-- CreateIndex
CREATE INDEX "BanditParametersHistory_MerchantId_idx" ON "BanditParametersHistory"("MerchantId");

-- CreateIndex
CREATE INDEX "BanditParametersHistory_ExperimentDatetimeSubmitted_idx" ON "BanditParametersHistory"("ExperimentDatetimeSubmitted");

-- AddForeignKey
ALTER TABLE "ExperimentMerchantInputs" ADD CONSTRAINT "ExperimentMerchantInputs_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentMerchantProductSnapshot" ADD CONSTRAINT "ExperimentMerchantProductSnapshot_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentSetup" ADD CONSTRAINT "ExperimentSetup_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentLive" ADD CONSTRAINT "ExperimentLive_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExperimentSubsets" ADD CONSTRAINT "ExperimentSubsets_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Impressions" ADD CONSTRAINT "Impressions_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchases" ADD CONSTRAINT "Purchases_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanditParameters" ADD CONSTRAINT "BanditParameters_MerchantId_fkey" FOREIGN KEY ("MerchantId") REFERENCES "Merchants"("MerchantId") ON DELETE RESTRICT ON UPDATE CASCADE;
