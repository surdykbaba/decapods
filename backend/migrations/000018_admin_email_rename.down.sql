UPDATE users
   SET email = 'admin@pgdp.local',
       updated_at = now()
 WHERE id = '22222222-0000-0000-0000-000000000001'
   AND email::text = 'sadiq@theaccubin.com';
