# Публикация BestyChat на Vercel

Vercel не хранит файлы между запросами, поэтому аккаунты, переписки и фото лежат в базе Upstash Redis (бесплатно подключается из самого Vercel).

1. Создай аккаунт на github.com и новый репозиторий (Private). Нажми «uploading an existing file» и загрузи всё содержимое папки проекта: `app.js`, `server.cjs`, `package.json`, `vercel.json`, `.gitignore`, папки `api` и `public`. Папку `data` НЕ загружай.
2. На vercel.com войди через GitHub → Add New → Project → выбери репозиторий → Deploy (Framework: Other).
3. В проекте: Storage → Create / Connect Database → Upstash (Redis) → подключи к проекту. Переменные базы добавятся сами.
4. Settings → Environment Variables, добавь:
   - `API_KEY` — ключ DeepSeek
   - `REPLICATE_API_TOKEN` — токен Replicate
   - `YOOKASSA_SHOP_ID` — номер магазина из кабинета ЮKassa
   - `YOOKASSA_SECRET_KEY` — секретный ключ ЮKassa (Интеграция → Ключи API)
   - `SITE_URL` — адрес сайта, например `https://bestychat.vercel.app` (куда вернётся покупатель после оплаты)
   - `FREE_SUBS` — не добавляй (или `0`). Значение `1` включает тарифы бесплатно, только для тестов
5. Deployments → Redeploy. Открой выданный адрес `*.vercel.app`.

6. В кабинете ЮKassa: Интеграция → HTTP-уведомления → укажи `https://ТВОЙ-САЙТ/api/yookassa` и отметь события `payment.succeeded` и `payment.canceled`. Без этого тариф включится только когда покупатель вернётся на сайт.

Если деплой ругается на `maxDuration`, открой `vercel.json` и поставь 60.
Ключи храни только в переменных Vercel, не в файлах.
