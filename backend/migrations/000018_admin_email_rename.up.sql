-- Rename the seeded admin user's email from admin@pgdp.local to the real
-- operator address. Idempotent — only fires if the seed row is still there
-- with the original email.
UPDATE users
   SET email = 'sadiq@theaccubin.com',
       updated_at = now()
 WHERE id = '22222222-0000-0000-0000-000000000001'
   AND email::text = 'admin@pgdp.local';
