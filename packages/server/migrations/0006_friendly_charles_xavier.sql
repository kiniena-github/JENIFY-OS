CREATE TABLE `template_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`label_key` text NOT NULL,
	`extends_id` text,
	`status` text DEFAULT 'published' NOT NULL,
	`definition` text NOT NULL,
	`created_by` text,
	`published_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_layers_ver` ON `template_layers` (`template_id`,`version`);--> statement-breakpoint
CREATE INDEX `template_layers_kind` ON `template_layers` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `tenant_template_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`version` integer NOT NULL,
	`layers` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_template_bindings_ver` ON `tenant_template_bindings` (`tenant_id`,`version`);