CREATE TABLE "conversations" (
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "conversations_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sandbox_id" text,
	"live_release_id" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"usage_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"message" text NOT NULL,
	"commit" text NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_project_id_id_pk" PRIMARY KEY("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;