-- CreateTable
CREATE TABLE "task_list" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_list_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "task" ADD COLUMN     "list_id" UUID;

-- CreateIndex
CREATE INDEX "task_list_owner_id_idx" ON "task_list"("owner_id");

-- CreateIndex
CREATE INDEX "task_list_id_idx" ON "task"("list_id");

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "task_list"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_list" ADD CONSTRAINT "task_list_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
