-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "plugin_shop_demo__product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdBy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "sku" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plugin_shop_demo__product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_shop_demo__order" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdBy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'new',
    "totalCents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "shipTo" JSONB NOT NULL,
    "note" TEXT,
    "product" TEXT,

    CONSTRAINT "plugin_shop_demo__order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_shop_demo__address" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "nodeId" TEXT,
    "ownerId" TEXT,
    "createdBy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "label" TEXT NOT NULL,
    "lines" TEXT NOT NULL,

    CONSTRAINT "plugin_shop_demo__address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plugin_shop_demo__product_workspaceId_nodeId_idx" ON "plugin_shop_demo__product"("workspaceId", "nodeId");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__product_nodeId_sku_idx" ON "plugin_shop_demo__product"("nodeId", "sku");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__product_nodeId_active_idx" ON "plugin_shop_demo__product"("nodeId", "active");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__order_workspaceId_nodeId_idx" ON "plugin_shop_demo__order"("workspaceId", "nodeId");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__order_ownerId_idx" ON "plugin_shop_demo__order"("ownerId");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__order_nodeId_status_idx" ON "plugin_shop_demo__order"("nodeId", "status");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__order_nodeId_createdAt_idx" ON "plugin_shop_demo__order"("nodeId", "createdAt");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__order_nodeId_product_idx" ON "plugin_shop_demo__order"("nodeId", "product");

-- CreateIndex
CREATE INDEX "plugin_shop_demo__address_ownerId_idx" ON "plugin_shop_demo__address"("ownerId");

