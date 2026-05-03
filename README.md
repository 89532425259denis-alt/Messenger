# DEVO+ Messenger

Бесплатный мессенджер на Cloudflare. Дизайн — frosted glass, минимализм, скруглённые углы, светлая/тёмная темы (как на дизайн-макетах `DEVO+`).

## Стек (бесплатные лимиты Cloudflare)

| Слой              | Сервис                           |
| ----------------- | -------------------------------- |
| Фронтенд          | Workers Static Assets            |
| API               | Cloudflare Workers               |
| Реалтайм-чаты     | Durable Objects + WebSocket      |
| База данных       | D1 (SQLite)                      |
| Медиа (фото, voice, файлы) | R2                       |
| Сессии / онлайн   | KV                               |

## Возможности

- Регистрация и вход по логину + паролю (PBKDF2-SHA-256, без SMS — всё в Free-тире).
- Личные чаты 1-на-1 и групповые чаты.
- Реалтайм-сообщения через WebSocket (Durable Object на каждый чат).
- Отправка текста, картинок, голосовых сообщений (через `MediaRecorder`), файлов.
- "Печатает…", присутствие (онлайн / был N минут назад), отметки прочтения.
- Поиск пользователей и поиск по списку чатов.
- Профиль, аватарка-инициал, био, переключатель темы.
- PWA-манифест + поддержка standalone установки.

## Структура

```
.
├── wrangler.toml           # Cloudflare конфигурация
├── package.json
├── migrations/
│   └── 0001_init.sql       # Схема D1
├── public/                 # Фронтенд (статические ассеты)
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── src/                    # Cloudflare Worker
    ├── index.js            # Роутинг
    ├── auth.js             # Регистрация / вход / профиль
    ├── chats.js            # Чаты, сообщения, поиск
    ├── chat-room.js        # Durable Object с WebSocket fan-out
    ├── media.js            # Загрузка/отдача R2
    └── util.js             # Хелперы (json, cookies, hash, ...)
```

## Запуск локально

```bash
npm install

# Создать локальную D1-схему
npm run db:migrate:local

# Запустить локальный воркер (http://localhost:8787)
npm run dev
```

После `npm run dev` откройте `http://localhost:8787`. Локальный wrangler сам поднимает D1, KV, R2 и Durable Objects в `.wrangler/state`.

## Деплой в Cloudflare

```bash
# 1. Логин
npx wrangler login

# 2. Создать D1, KV и R2 (один раз)
npm run db:create        # → запишите database_id в wrangler.toml
npm run kv:create        # → запишите id KV в wrangler.toml
npm run r2:create

# 3. Применить миграции к удалённой БД
npm run db:migrate:remote

# 4. Деплой
npm run deploy
```

Воркер заберёт ассеты из `public/` и поднимется на `https://devo-messenger.<account>.workers.dev`. Можете привязать собственный домен через панель Cloudflare.

## API

| Метод | Путь                                | Описание                               |
| ----- | ----------------------------------- | -------------------------------------- |
| POST  | `/api/auth/register`                | Регистрация                            |
| POST  | `/api/auth/login`                   | Вход                                   |
| POST  | `/api/auth/logout`                  | Выход                                  |
| GET   | `/api/auth/me`                      | Текущий пользователь                   |
| PATCH | `/api/me`                           | Обновить профиль                       |
| GET   | `/api/users/search?q=`              | Поиск пользователей                    |
| GET   | `/api/chats`                        | Список чатов                           |
| POST  | `/api/chats`                        | Создать чат (`type=direct/group`)      |
| GET   | `/api/chats/:id`                    | Чат + участники                        |
| GET   | `/api/chats/:id/messages?before=`   | История сообщений                      |
| POST  | `/api/chats/:id/messages`           | Отправить сообщение                    |
| DELETE| `/api/chats/:id/messages/:msg`      | Удалить своё сообщение                 |
| POST  | `/api/chats/:id/read`               | Отметить как прочитанное               |
| POST  | `/api/media`                        | Загрузить медиа (raw body)             |
| GET   | `/media/:key`                       | Скачать медиа из R2                    |
| WS    | `/ws/:chatId`                       | Реалтайм-канал чата                    |

## Дальше

- Аудио/видео-звонки через WebRTC + Cloudflare Calls (бета).
- E2E шифрование (Signal-протокол) — кладём только зашифрованные `body` в D1.
- Push-уведомления через VAPID или OneSignal.
- Stories / каналы / реакции / ответы.
