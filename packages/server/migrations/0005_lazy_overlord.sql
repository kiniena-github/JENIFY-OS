CREATE TABLE `language_pack_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`key_id` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `language_pack_entries_key` ON `language_pack_entries` (`pack_id`,`key_id`);--> statement-breakpoint
CREATE TABLE `language_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`scope_value` text DEFAULT '' NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'official' NOT NULL,
	`notes` text,
	`created_by` text,
	`approved_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `language_packs_ver` ON `language_packs` (`language`,`scope`,`scope_value`,`version`);--> statement-breakpoint
CREATE INDEX `language_packs_lang` ON `language_packs` (`language`,`status`);--> statement-breakpoint
CREATE TABLE `translation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`language` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`scope_value` text DEFAULT '' NOT NULL,
	`decision` text NOT NULL,
	`value` text,
	`previous_value` text,
	`reason` text,
	`decided_by` text,
	`decided_at` text NOT NULL,
	`pack_version` integer
);
--> statement-breakpoint
CREATE INDEX `translation_decisions_key` ON `translation_decisions` (`key_id`,`language`);--> statement-breakpoint
ALTER TABLE `tenants` ADD `sector` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `country` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `region` text;