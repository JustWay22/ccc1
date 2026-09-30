# DreamChat

Локально: Node.js 18+, затем
  Windows (PowerShell): $env:API_KEY="..."; $env:REPLICATE_API_TOKEN="..."; node server.cjs
  Mac/Linux: API_KEY=... REPLICATE_API_TOKEN=... node server.cjs
Открой http://localhost:3000

Переменные: API_KEY, BASE_URL, MODEL, REPLICATE_API_TOKEN, IMAGE_MODEL, DAILY_LIMIT (25), PHOTO_LIMIT (3), FREE_SUBS (1 = тарифы включаются бесплатно), PORT.
Тарифы (server app.js, PLANS): Plus 499 ₽, VIP 990 ₽, SUPER 2990 ₽.
Публикация на Vercel: см. DEPLOY.md
