CREATE INDEX `payments_date` ON `payments` (`tenant_id`,`date`);--> statement-breakpoint
CREATE INDEX `qc_tenant_batch` ON `quality_tests` (`tenant_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `invoices_date` ON `sales_invoices` (`tenant_id`,`date`);--> statement-breakpoint
CREATE INDEX `movements_type_time` ON `stock_movements` (`tenant_id`,`movement_type`,`posted_at`);--> statement-breakpoint
CREATE INDEX `translations_tenant_lang` ON `translations` (`tenant_id`,`language`);--> statement-breakpoint
CREATE INDEX `translations_lang_status` ON `translations` (`language`,`status`);