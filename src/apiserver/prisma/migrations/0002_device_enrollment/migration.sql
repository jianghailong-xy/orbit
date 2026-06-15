-- CreateTable
CREATE TABLE "DeviceEnrollment" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "runnerId" TEXT,
    "runnerToken" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceEnrollment_deviceCodeHash_key" ON "DeviceEnrollment"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceEnrollment_userCode_key" ON "DeviceEnrollment"("userCode");
