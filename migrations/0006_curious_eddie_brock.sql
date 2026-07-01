ALTER TABLE "bookmarks" ADD COLUMN "external_launch_key" text;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "external_launch_source" text;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_external_launch_key_unique" UNIQUE("external_launch_key");
