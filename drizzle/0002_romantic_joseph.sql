ALTER TABLE "projects" ADD COLUMN "subdomain" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_subdomain_unique" UNIQUE("subdomain");