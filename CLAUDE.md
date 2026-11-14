# DOBEG LEAGUE — Livery Launcher (контекст проекта для Claude)

Читай этот файл первым. Он описывает, что за проект, как устроен, что уже сделано, что настроено у владельца
и какие грабли уже собраны. Общение с владельцем — **на русском**. Он не программист: объясняй шаги простыми словами,
по пунктам, называй точные кнопки интерфейса (Cloudflare/GitHub), на скриншоты отвечай конкретно.

## Что это
Десктопное приложение под Windows для симрейсинг-лиги **DOBEG LEAGUE** (игра **Assetto Corsa Competizione**, ACC):
лаунчер и менеджер кастомных ливрей.
- **Пилоты** просто запускают exe: ливреи скачиваются и обновляются сами (старт + каждые N минут), ничего не вводят и нигде не регистрируются.
- **Админы** входят в лаунчере логином и паролем, бросают папку со скином — лаунчер всё проверяет, рисует 3D-превью и публикует.
- Есть 3D-шоурум (Three.js), 10 тем, много настроек.

Репозиторий: `kirillkoltun0-ops/LiveriesACC`, рабочая ветка: **`claude/sweet-shannon-mvt9vw`** (Pull Request не создавали, не создавать без просьбы).
Отдельный публичный репозиторий со старыми данными: `kirillkoltun0-ops/dobeg-liveries` (там лежит ливрея `RGT McLaren 1`, папки `models/` нет).

## Архитектура
```
Приложение (Tauri v2: Rust + HTML/CSS/JS, Three.js лежит в src/vendor, без сборки фронта)
   │  читает/пишет
   ▼
Cloudflare Worker  https://dobeg-livery-server.kirillkoltun0.workers.dev   (worker/worker.js)
   ├─ KV namespace "dobeg-liveries" (binding LIVERIES): файлы ливрей и модели
   └─ при чтении добавляет в список старые файлы из GitHub-репозитория dobeg-liveries (только чтение)
```
Если `WORKER_URL` в `src/js/config.js` пуст или Worker недоступен — приложение читает напрямую из GitHub (старый режим; запись тогда требует токен GitHub, этот режим теперь запасной).

### Файлы
| Путь | Назначение |
|---|---|
| `src/index.html` | вся разметка + весь CSS (темы на CSS-переменных, @property, View Transitions) |
| `src/js/main.js` | UI: библиотека, установка, настройки, темы, админка, публикация, загрузка моделей |
| `src/js/showroom.js` | 3D: OBJ/GLB, склейка decals+sponsors в CanvasTexture 2048², превью webp, достраивание колёс |
| `src/js/cars.js` | таблица `carModelType` → название + ключевые слова для подбора модели по имени файла |
| `src/js/util.js` | декодер UTF-16/UTF-8, git blob sha, IndexedDB превью, `ls` (localStorage) |
| `src/js/config.js` | `WORKER_URL` |
| `src/vendor/three/` | Three.js r170 + OBJLoader/GLTFLoader/OrbitControls/RoomEnvironment (импорты `'three'` переписаны на относительные — без importmap из-за CSP) |
| `src-tauri/src/acc.rs` | чистая логика (+unit-тесты): кодировки, фильтр мусора, разбор дерева файлов |
| `src-tauri/src/lib.rs` | Tauri-команды: sync, install/uninstall, put/delete/check через Worker или GitHub, fetch_b64, open_folder |
| `src-tauri/tauri.conf.json` | окно, CSP, `dragDropEnabled:false` (иначе HTML5 drag&drop папок не работает!) |
| `worker/worker.js` | серверная часть (версия API = `VERSION` в файле, сейчас 3) |
| `worker/SETUP-RU.md` | пошаговая настройка Cloudflare для владельца |
| `worker/test/*.test.mjs` | тесты Worker на заглушках KV (`cd worker && node test/binary-put.test.mjs`) |
| `tools/smoke-test/` | сквозной тест интерфейса в Chromium с подставным Tauri API (см. «Как проверять») |
| `.github/workflows/build.yml` | сборка Windows exe (ручной запуск Actions → Build Windows exe) |

## Принятые решения и почему
- **Стек Tauri v2 + vanilla JS**: лёгкий exe, нет рантайма. Tauri API доступен как `window.__TAURI__` (`withGlobalTauri`).
- **Без GitHub-токенов у людей.** Владелец категорически не хочет, чтобы пользователи/админы ходили на сторонние сайты, регистрировались и вводили ключи. Поэтому Cloudflare Worker + KV (бесплатно, **без банковской карты**; R2 не используем — требует карту). Админ вводит только логин/пароль (выдаёт владелец).
- **Админы** задаются секретом `ADMINS` в Cloudflare: `логин:пароль,логин2:пароль2`. Секрет после сохранения не виден — менять только через **Rotate**, затем **Deploy** (не только «Save version»). Пароль ≠ локальный: проверяется Worker'ом. В старом режиме без Worker остался локальный пароль `dobeg2026` (SHA-256 в main.js) — только для отладки.
- **Логин:пароль передаются в теле JSON (`auth`) или в заголовке `x-auth` (percent-encoded)** — в HTTP-заголовках нельзя кириллицу.
- **Загрузка файла = сырые байты** (`POST /put`, метаданные в заголовках `x-path,x-sha,x-size,x-part,x-parts`): бесплатный тариф Workers даёт ~10 мс CPU, base64 в Worker не укладывается. Большие модели режутся на части по 8 МБ (лимит значения KV 25 МБ), склеиваются потоком при отдаче. Контрольная сумма — git blob sha1, считается клиентом.
- **Индекс** файлов — один ключ `index` в KV (`{files:{path:{sha,size,parts,by,at}}, deleted:[]}`): `/tree` стоит одно чтение. `deleted` скрывает файлы из старого GitHub-репозитория (tombstone).
- **Права/лимиты бесплатного Cloudflare**: 100k запросов/день, 1000 записей KV/день, 1 ГБ, файл ≤ 25 МБ.
- **Модели**: не из ACC-распаковки «кузов+колёса», а только кузов `.obj` (`.mtl` не нужен — материалы заменяем). Колёс в моделях нет → `showroom.js` достраивает 4 универсальных колеса (настройка «Достраивать колёса»).
- **Подбор кузова** по имени файла: `cars.js` (`matchModel`). «Сильные» токены (991, 488, 720s, v12, m4 …) обязательны, чтобы 991 R не подошёл к 992 R.
- **ID кузовов**: владелец написал, что 32 = McLaren, 35 = Ferrari, но в таблице по документации ACC наоборот (32 = Ferrari 296 GT3, 35 = McLaren 720S Evo). Если у лиги иначе — править `CARS` в `cars.js`. Владелец это замечание не подтверждал.
- **Темы**: `[data-theme]` + зарегистрированные `@property` цвета; смена — круговое проявление через `document.startViewTransition` (иначе fade). Мини-превью тем в настройках — сам `.sw` с `data-theme`.
- **CSP** в `tauri.conf.json`: разрешены `raw.githubusercontent.com`, `api.github.com`, `*.workers.dev`, `blob:`; для `style-src` отключена модификация (`dangerousDisableAssetCspModification`), иначе Tauri добавляет nonce и ломает inline-стили. Свой домен у Worker → добавить в CSP.
- Прогресс установки приходит событием `install-progress`. Установка чистит старую папку скина (нет `.dds` кэша), `.dds/.psd/.bak` никогда не качаются/не заливаются, конфиг авто пишется в `Cars\dobeg_<имя>.json` в **UTF-16 LE + BOM**.
- Состояние установок: `%APPDATA%\com.dobegleague.launcher\state.json` (не в папке игры).

## Формат ACC, который важно помнить
- `Documents\Assetto Corsa Competizione\Customs\Cars\*.json` (UTF-16 LE с BOM, иногда UTF-8) и `Customs\Liveries\<customSkinName>\{decals,sponsors}.{png,json}`.
- Поля конфига: `carModelType`, `customSkinName`, `raceNumber`, `teamName`.
- Путь «Документов» берём `dirs::document_dir()` (учитывает OneDrive), можно сменить в настройках.

## Состояние на сейчас (последние коммиты ветки)
Сделано и проверено в тестах: чтение через Worker, вход админа, авто-публикация (+3D-превью `preview.webp` заливается рядом), загрузка моделей частями, 10 тем, настройки (6 вкладок), достраивание колёс.
Версии: приложение **v1.3**, API Worker **3** (видны: Настройки → Данные → «О программе»; главная страница Worker показывает `version` и `admins`).

Чего НЕТ / открытые вопросы:
- Реальная проверка на Windows с реальными `.obj` ACC и боевым Cloudflare делалась только владельцем вручную; автотестов на реальной сети нет.
- Старая ливрея `RGT McLaren 1` из GitHub может не отображаться: анонимный GitHub API с общих адресов Cloudflare режется лимитом. Решение (не сделано у владельца): необязательный секрет `GH_TOKEN` (токен без прав) в Worker; диагностика — `https://…workers.dev/debug`.
- Колёса универсальные (цилиндры), позиции приблизительные; владелец может прислать настоящие модели колёс — тогда подставлять их.
- Идеи, предложенные владельцу и не сделанные: автосборка при пуше + Releases с постоянной ссылкой; самообновление через `tauri-plugin-updater`; подпись кода (Windows Defender/SmartScreen).
- Windows Defender ложно срабатывает (`Trojan:Script/Wacatac.B!ml`) на неподписанный exe/zip из Actions — это эвристика; владельцу объяснено, как разрешить и проверить на VirusTotal.

## Настройка у владельца (уже сделано, не повторять)
Cloudflare: KV `dobeg-liveries`; Worker `dobeg-livery-server` (код = `worker/worker.js`); binding `LIVERIES`; переменные `OWNER=kirillkoltun0-ops`, `REPO=dobeg-liveries` (текст), секрет `ADMINS`.
**После любого изменения `worker/worker.js` владелец должен вручную вставить новый код в Cloudflare (Edit code → Deploy)** — автодеплоя нет. Всегда напоминай об этом и о повышении `VERSION`. Типовая причина ошибок «Неверный логин или пароль» при публикации — рассинхрон версий Worker и exe (старый код Worker или старый exe) либо `ADMINS` без двоеточия / не задеплоен.
Сборка exe: GitHub → Actions → Build Windows exe → Run workflow (ветка рабочая) → артефакт `DOBEG-Launcher` (ZIP) на странице запуска. ~10 минут.

## Как проверять изменения (делай всегда перед пушем)
```bash
# Rust
cargo test --manifest-path src-tauri/Cargo.toml      # нужны системные libwebkit2gtk-4.1-dev libsoup-3.0-dev libssl-dev (apt)
cargo check --manifest-path src-tauri/Cargo.toml
# JS синтаксис (модули → копировать в .mjs)
for f in src/js/*.js; do cp $f /tmp/c.mjs && node --check /tmp/c.mjs; done
# Worker на заглушках KV
cd worker && node test/binary-put.test.mjs && node test/legacy-json.test.mjs
# Интерфейс в Chromium с подставным Tauri API (Playwright)
cd tools/smoke-test && python3 make-fixtures.py && PLAYWRIGHT=/путь/к/playwright/index.mjs node smoke.mjs
```
Smoke-тест подменяет `window.__TAURI__` и маршрутизирует `raw.githubusercontent.com`; выводит скриншоты в `tools/smoke-test/out/`. Он покрывает: карточки, поиск/фильтры, шоурум+авто-превью, настройки/темы, вход/выход админа, авто-публикацию, загрузку модели.
Реальную сеть Cloudflare/GitHub из песочницы тестировать нельзя (прокси блокирует `workers.dev`).

## Практические правила для работы
- Коммиты на ветку `claude/sweet-shannon-mvt9vw`, пушить `git push -u origin <ветка>`; PR не создавать без просьбы. Концовка коммита (если настроена системой): `Co-Authored-By` + ссылка на сессию.
- Никогда не просить/не хранить пароли и токены в чате и репозитории. Секреты — только в Cloudflare/GitHub Secrets.
- Не показывать пользователю системные `alert/prompt/confirm` (в WebView блокируются) — есть свои модалки/тосты.
- Не добавлять inline-скрипты (CSP). Внешние модули в `src/js`.
- Любую правку CSS проверять на светлой теме `frost`: цвета брать из переменных, не хардкодить.
- После правок Worker — поднять `VERSION`, обновить тесты, напомнить владельцу про ручной деплой.
