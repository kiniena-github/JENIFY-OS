ALTER TABLE `parties` ADD `default_price_category` text;--> statement-breakpoint
ALTER TABLE `production_stages` ADD `output_policy` text DEFAULT 'measured' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenant_languages` ADD `native_name` text;--> statement-breakpoint
ALTER TABLE `tenant_languages` ADD `direction` text DEFAULT 'ltr' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `theme` text DEFAULT 'system' NOT NULL;