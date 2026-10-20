# DOBEG LEAGUE — Livery Launcher

Десктопный лаунчер ливрей для ACC (Windows). Стек: **Tauri v2** (Rust) + чистые HTML/CSS/JS + **Three.js** (r170, лежит локально в `src/vendor`, CDN не нужен). Сборка фронтенда не требуется.

## Структура
```
src/index.html          разметка + все стили и анимации
src/js/main.js          UI, синхронизация, установка, админ-панель
src/js/showroom.js      3D-шоурум: .obj/.glb, склейка decals+sponsors, превью
src/js/cars.js          carModelType → название и ключевые слова для подбора модели
src/js/util.js          UTF-16/UTF-8 декодер, git-sha, IndexedDB
src/vendor/three/       Three.js + OBJLoader/GLTFLoader/OrbitControls
src-tauri/src/acc.rs    чистая логика: кодировки, фильтр мусора, разбор дерева GitHub (+ unit-тесты)
src-tauri/src/lib.rs    Tauri-команды: sync, install/uninstall, GitHub PUT/DELETE
```

## Сборка
```
cargo install tauri-cli --version "^2" --locked
cargo tauri dev                      # запуск в режиме разработки
cargo tauri build --no-bundle        # один portable .exe → src-tauri/target/release/dobeg-launcher.exe
cargo tauri build                    # + NSIS-установщик
cargo test --manifest-path src-tauri/Cargo.toml
```
Без Windows-машины: Actions → **Build Windows exe** → Run workflow, exe появится в артефактах.
Иконки заменяются командой `cargo tauri icon путь/к/logo.png`.

## Админ-панель
Пароль: `dobeg2026` (хранится как SHA-256). Это защита «от случайного клика» — настоящая защита репозитория это **GitHub-токен**:
fine-grained PAT только на `dobeg-liveries`, право *Contents: Read and write*.

## Структура репозитория с ливреями
Лаунчер находит любую папку с `decals.png`/`sponsors.png` на любой глубине (`Команда/Скин/…` или `Скин/…`).
Админка публикует в `Команда/ИмяСкина/{decals.png,sponsors.png,decals.json,sponsors.json,car_config.json}`.
3D-модели — в `models/*.obj|glb`.
