# Настройка сервера-посредника (Cloudflare Worker) — 10 минут, бесплатно

После этого **ни пилотам, ни админам не нужны токены GitHub**. Токен хранится только в Cloudflare.

## 1. Токен GitHub (один раз, для Worker)
GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
- Repository access: **Only select repositories → `dobeg-liveries`**
- Permissions → **Repository** → **Contents: Read and write**
- Срок действия — любой (лучше задать). Скопируйте токен `github_pat_…`.

## 2. Создайте Worker
1. Зарегистрируйтесь на https://dash.cloudflare.com (бесплатно).
2. **Workers & Pages → Create → Create Worker** → имя `dobeg-livery-proxy` → **Deploy**.
3. Откройте **Edit code**, удалите всё, вставьте содержимое файла `worker/worker.js` → **Deploy**.

## 3. Переменные
Worker → **Settings → Variables and Secrets → Add**:

| Тип | Имя | Значение |
|---|---|---|
| Text | `OWNER` | `kirillkoltun0-ops` |
| Text | `REPO` | `dobeg-liveries` |
| **Secret** | `GH_TOKEN` | токен из шага 1 |
| **Secret** | `ADMIN_KEYS` | `Кирилл:ключ1,Иван:ключ2` |

`ADMIN_KEYS` — это личные ключи админов в формате `имя:ключ` через запятую. Придумайте длинные случайные ключи (16+ символов).
Имя админа попадает в сообщение коммита — видно, кто что загрузил. Чтобы отозвать админа, удалите его пару и сохраните.

## 4. Адрес Worker
На странице Worker скопируйте адрес вида `https://dobeg-livery-proxy.<аккаунт>.workers.dev`.
Проверка: откройте `адрес/tree` в браузере — должен вернуться JSON со списком файлов репозитория.

Впишите адрес в `src/js/config.js` (`WORKER_URL`) и пересоберите приложение — либо пока введите его в
**Настройки → Синхронизация → Адрес сервера** для проверки.

## 5. Использование
- Пилоты: ничего не вводят.
- Админ: вкладка «Админ-панель» → один раз вводит свой ключ → бросает папку с ливреей.

Если Worker недоступен, лаунчер пилота автоматически читает данные напрямую из GitHub.
