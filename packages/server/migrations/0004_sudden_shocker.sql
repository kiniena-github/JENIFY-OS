ALTER TABLE `payments` ADD `currency` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `fx_rate` real;--> statement-breakpoint
ALTER TABLE `payments` ADD `original_amount_cents` integer;