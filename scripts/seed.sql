-- Sample data for local development. Idempotent (INSERT OR IGNORE).
-- Dev-only smoke seed: these ids/statuses do not exercise the production identity keys or rollup
-- conventions used by the admin/OCDS normalization pipeline.

INSERT OR IGNORE INTO authorities (id, name, bulstat, region) VALUES
  ('auth-sofia', 'Община София', '000696327', 'София-град'),
  ('auth-mrrb', 'Министерство на регионалното развитие', '831661388', 'София-град');

INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, status, published_at, deadline_at)
VALUES
  ('demo-tender', 'AOP-2026-0001', 'Доставка на хранителни продукти за детски градини', 'auth-sofia', '15000000', 1200000, 'BGN', 'открита процедура', 'published', '2026-03-01', '2026-04-01'),
  ('t-build-01', 'AOP-2026-0002', 'Ремонт на общински път', 'auth-mrrb', '45000000', 3500000, 'BGN', 'открита процедура', 'evaluation', '2026-02-15', '2026-03-20');

INSERT OR IGNORE INTO bidders (id, name, bulstat) VALUES
  ('bidder-a', 'Алфа ЕООД', '111111111'),
  ('bidder-b', 'Бета АД', '222222222'),
  ('bidder-c', 'Гама ООД', '333333333');
