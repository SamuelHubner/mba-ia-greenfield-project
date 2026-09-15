import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1789510612605 implements MigrationInterface {
  name = 'CreateVideos1789510612605';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_status" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "status" "public"."video_status" NOT NULL DEFAULT 'draft', "original_file_name" character varying(255) NOT NULL, "mime_type" character varying(100) NOT NULL, "source_ext" character varying(8) NOT NULL, "source_key" character varying(255) NOT NULL, "thumbnail_key" character varying(255), "declared_size_bytes" bigint NOT NULL, "duration_seconds" integer, "width" integer, "height" integer, "video_codec" character varying(32), "size_bytes" bigint, "processing_error" text, "processed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_bebd291980f461ea34efae42703" UNIQUE ("url_id"), CONSTRAINT "UQ_a9a68fdfc777b235a4c47bbbea5" UNIQUE ("source_key"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ece1558efc6efd53eb530479db" ON "videos" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "video_uploads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "video_id" uuid NOT NULL, "storage_upload_id" character varying(255) NOT NULL, "part_size" integer NOT NULL, "part_count" integer NOT NULL, "upload_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE, "aborted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_06a943c51e95702c3e84693180" UNIQUE ("video_id"), CONSTRAINT "PK_c3def71eaaba3a49539786ef82a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_uploads" ADD CONSTRAINT "FK_06a943c51e95702c3e84693180f" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "video_uploads" DROP CONSTRAINT "FK_06a943c51e95702c3e84693180f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP TABLE "video_uploads"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ece1558efc6efd53eb530479db"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_status"`);
  }
}
