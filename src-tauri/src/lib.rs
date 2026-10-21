mod acc;

use acc::{CarMeta, Livery, ModelFile, TreeEntry};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::{stream, StreamExt};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const OWNER: &str = "kirillkoltun0-ops";
const REPO: &str = "dobeg-liveries";

/// Кодируем каждый сегмент пути (кириллица, пробелы, #, ? и т.д.)
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

fn enc_path(path: &str) -> String {
    path.split('/')
        .map(|s| utf8_percent_encode(s, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn raw_url(rev: &str, path: &str) -> String {
    format!("https://raw.githubusercontent.com/{OWNER}/{REPO}/{rev}/{}", enc_path(path))
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("DOBEG-Launcher/1.0")
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("http client")
    })
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn err<E: std::fmt::Display>(ctx: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{ctx}: {e}")
}

// ───────────────────────── Состояние установки ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub folder: String,
    pub car_file: Option<String>,
    pub sig: String,
    pub installed_at: u64,
}

type StateMap = HashMap<String, HashMap<String, Installed>>; // customs → (livery id → Installed)

static STATE_LOCK: Mutex<()> = Mutex::new(());

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(err("app_data_dir"))?;
    fs::create_dir_all(&d).map_err(err("create app dir"))?;
    Ok(d)
}

fn load_state(app: &AppHandle) -> Result<StateMap, String> {
    let p = data_dir(app)?.join("state.json");
    Ok(fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

fn save_state(app: &AppHandle, st: &StateMap) -> Result<(), String> {
    let p = data_dir(app)?.join("state.json");
    fs::write(p, serde_json::to_string_pretty(st).unwrap_or_default()).map_err(err("save state"))
}

fn with_state<T>(app: &AppHandle, customs: &str, f: impl FnOnce(&mut HashMap<String, Installed>) -> T) -> Result<T, String> {
    let _g = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut st = load_state(app)?;
    let r = f(st.entry(customs.to_string()).or_default());
    save_state(app, &st)?;
    Ok(r)
}

fn liveries_dir(customs: &str) -> PathBuf {
    Path::new(customs).join("Liveries")
}
fn cars_dir(customs: &str) -> PathBuf {
    Path::new(customs).join("Cars")
}

// ───────────────────────── Команды: пути ─────────────────────────

#[tauri::command]
fn default_customs_path() -> String {
    // dirs::document_dir() на Windows использует Known Folder API → корректно работает с OneDrive\Документы
    let docs = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
        .unwrap_or_else(|| PathBuf::from("."));
    docs.join("Assetto Corsa Competizione").join("Customs").to_string_lossy().into_owned()
}

#[tauri::command]
fn ensure_customs(customs: String) -> Result<Value, String> {
    let existed = Path::new(&customs).exists();
    fs::create_dir_all(cars_dir(&customs)).map_err(err("Не удалось создать Customs\\Cars"))?;
    fs::create_dir_all(liveries_dir(&customs)).map_err(err("Не удалось создать Customs\\Liveries"))?;
    Ok(json!({ "existed": existed }))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(err("Папка недоступна"))?;
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let cmd = "xdg-open";
    // explorer.exe возвращает код 1 даже при успехе — статус не проверяем
    std::process::Command::new(cmd).arg(&path).spawn().map_err(err("Не удалось открыть Проводник"))?;
    Ok(())
}

// ───────────────────────── Команды: синхронизация ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteData {
    commit: String,
    liveries: Vec<Livery>,
    models: Vec<ModelFile>,
    truncated: bool,
    owner: &'static str,
    repo: &'static str,
}

fn gh_headers(rb: reqwest::RequestBuilder, token: &Option<String>) -> reqwest::RequestBuilder {
    let rb = rb
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    match token.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => rb.bearer_auth(t),
        _ => rb,
    }
}

fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => "Токен GitHub недействителен или просрочен (401)".into(),
        403 | 429 if msg.to_lowercase().contains("rate limit") => {
            "Достигнут лимит запросов GitHub API (60/час без токена). Подождите или укажите токен в настройках.".into()
        }
        403 if msg.contains("not accessible") => "У токена нет права записи. На GitHub: Permissions → Repository → Contents → Read and write, и доступ к репозиторию dobeg-liveries.".into(),
        403 => format!("Нет прав доступа (403): {msg}"),
        404 => format!("Не найдено (404): {msg}. Для токена нужны права Contents: Read and write на репозиторий."),
        422 => format!("GitHub отклонил запрос (422): {msg}"),
        c => format!("GitHub вернул {c}: {msg}"),
    }
}

async fn fetch_meta(rev: String, l: Livery, cache: std::sync::Arc<Mutex<HashMap<String, CarMeta>>>) -> Livery {
    let mut l = l;
    let Some(cf) = l.car_file.clone() else { return l };
    if let Some(m) = cache.lock().ok().and_then(|c| c.get(&cf.sha).cloned()) {
        l.meta = Some(m);
        return l;
    }
    let meta_url = cf.url.clone().unwrap_or_else(|| raw_url(&rev, &cf.path));
    if let Ok(resp) = http().get(meta_url).send().await {
        if resp.status().is_success() {
            if let Ok(bytes) = resp.bytes().await {
                if let Some((_, m)) = acc::parse_car_json(&bytes) {
                    if let Ok(mut c) = cache.lock() {
                        c.insert(cf.sha.clone(), m.clone());
                    }
                    l.meta = Some(m);
                }
            }
        }
    }
    l
}

fn worker_base(w: &Option<String>) -> Option<String> {
    w.as_deref().map(|x| x.trim().trim_end_matches('/').to_string()).filter(|x| x.starts_with("http"))
}

type TreeData = (String, Vec<TreeEntry>, bool);

/// Дерево репозитория через Worker (кэш на стороне Cloudflare, без лимита 60/час).
async fn fetch_tree_worker(base: &str) -> Result<TreeData, String> {
    let r = http().get(format!("{base}/tree")).send().await.map_err(err("Сервер недоступен"))?;
    let st = r.status();
    let body = r.text().await.map_err(err("Чтение ответа"))?;
    let v: Value = serde_json::from_str(&body).map_err(err("Некорректный ответ сервера"))?;
    if !st.is_success() {
        return Err(v["error"].as_str().unwrap_or("Ошибка сервера").to_string());
    }
    let commit = v["commit"].as_str().unwrap_or("HEAD").to_string();
    let entries: Vec<TreeEntry> = serde_json::from_value(v["tree"].clone()).map_err(err("Разбор дерева"))?;
    Ok((commit, entries, v["truncated"].as_bool().unwrap_or(false)))
}

/// Прямой запрос к GitHub API (запасной путь).
async fn fetch_tree_direct(token: &Option<String>) -> Result<TreeData, String> {
    // SHA последнего коммита — raw-ссылки с SHA неизменяемы, CDN не отдаст устаревший файл
    let mut rev = "HEAD".to_string();
    let commit_url = format!("https://api.github.com/repos/{OWNER}/{REPO}/commits/HEAD");
    if let Ok(r) = gh_headers(http().get(&commit_url), token).header("Accept", "application/vnd.github.sha").send().await {
        if r.status().is_success() {
            if let Ok(t) = r.text().await {
                let t = t.trim().to_string();
                if t.len() == 40 && t.chars().all(|c| c.is_ascii_hexdigit()) {
                    rev = t;
                }
            }
        }
    }
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/git/trees/{rev}?recursive=1");
    let resp = gh_headers(http().get(&url), token).send().await.map_err(err("Нет связи с GitHub"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(err("Ошибка чтения ответа"))?;
    if !status.is_success() {
        return Err(http_error(status, &body));
    }
    let v: Value = serde_json::from_str(&body).map_err(err("Некорректный ответ GitHub"))?;
    let entries: Vec<TreeEntry> =
        serde_json::from_value(v.get("tree").cloned().unwrap_or(Value::Array(vec![]))).map_err(err("Разбор дерева"))?;
    Ok((rev, entries, v.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false)))
}

#[tauri::command]
async fn sync_remote(app: AppHandle, token: Option<String>, worker: Option<String>) -> Result<RemoteData, String> {
    let (rev, entries, truncated) = match worker_base(&worker) {
        // при настроенном Worker ключ админа никогда не уходит в GitHub: запасной путь — без токена
        Some(base) => match fetch_tree_worker(&base).await {
            Ok(t) => t,
            Err(_) => fetch_tree_direct(&None).await?,
        },
        None => fetch_tree_direct(&token).await?,
    };
    let (liveries, models) = acc::parse_tree(&entries);

    // Метаданные машин (номер, кузов) — с кэшем по sha блоба
    let cache_path = data_dir(&app)?.join("meta_cache.json");
    let cache: HashMap<String, CarMeta> =
        fs::read_to_string(&cache_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let cache = std::sync::Arc::new(Mutex::new(cache));
    let liveries: Vec<Livery> = stream::iter(liveries.into_iter().map(|l| fetch_meta(rev.clone(), l, cache.clone())))
        .buffered(8)
        .collect()
        .await;
    if let Ok(c) = cache.lock() {
        let _ = fs::write(&cache_path, serde_json::to_string(&*c).unwrap_or_default());
    }

    Ok(RemoteData { commit: rev, liveries, models, truncated, owner: OWNER, repo: REPO })
}

// ───────────────────────── Команды: установка ─────────────────────────

#[tauri::command]
fn installed_state(app: AppHandle, customs: String) -> Result<HashMap<String, Installed>, String> {
    with_state(&app, &customs, |m| {
        // игрок мог удалить папку вручную — забываем такие записи
        m.retain(|_, v| liveries_dir(&customs).join(&v.folder).is_dir());
        m.clone()
    })
}

async fn download(url: &str, label: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for attempt in 0..3 {
        match http().get(url).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = e.to_string(),
            },
            Ok(r) => last = format!("HTTP {}", r.status()),
            Err(e) => last = e.to_string(),
        }
        tokio_sleep(300 * (attempt + 1)).await;
    }
    Err(format!("Не удалось скачать {label}: {last}"))
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms)))
        .await
        .ok();
}

#[tauri::command]
async fn install_livery(app: AppHandle, customs: String, livery: Livery, commit: String) -> Result<Installed, String> {
    // файлы, которые нужны игре: 4 текстуры/материала + конфиг машины. Мусор (.dds/.psd/.bak) не качаем вообще.
    let mut wanted: Vec<acc::RemoteFile> = livery.files.iter().filter(|f| acc::is_skin_file(&f.name)).cloned().collect();
    if !wanted.iter().any(|f| f.name.to_lowercase().ends_with(".png")) {
        return Err("В ливрее нет decals.png / sponsors.png".into());
    }
    if let Some(cf) = &livery.car_file {
        wanted.push(cf.clone());
    }
    let total = wanted.len();
    let id = livery.id.clone();

    let results: Vec<(acc::RemoteFile, Result<Vec<u8>, String>)> = {
        let mut done = 0usize;
        let mut out = Vec::new();
        let mut s = stream::iter(wanted.into_iter().map(|f| {
            let url = f.url.clone().unwrap_or_else(|| raw_url(&commit, &f.path));
            async move {
                let r = download(&url, &f.path).await;
                (f, r)
            }
        }))
        .buffer_unordered(4);
        while let Some(item) = s.next().await {
            done += 1;
            let _ = app.emit("install-progress", json!({ "id": id, "done": done, "total": total }));
            out.push(item);
        }
        out
    };
    let mut files: Vec<(String, Vec<u8>, bool)> = Vec::new();
    for (f, r) in results {
        let is_car = livery.car_file.as_ref().map(|c| c.path == f.path).unwrap_or(false);
        files.push((f.name, r?, is_car));
    }

    // имя папки: customSkinName из конфига машины, иначе имя папки на GitHub
    let car_raw = files.iter().find(|(_, _, c)| *c).map(|(_, b, _)| b.clone());
    let parsed = car_raw.as_deref().and_then(acc::parse_car_json);
    let folder = acc::sanitize_name(
        parsed
            .as_ref()
            .and_then(|(_, m)| m.custom_skin_name.clone())
            .as_deref()
            .unwrap_or(&livery.name),
    );

    fs::create_dir_all(cars_dir(&customs)).map_err(err("Customs\\Cars"))?;
    fs::create_dir_all(liveries_dir(&customs)).map_err(err("Customs\\Liveries"))?;

    // чистим старую версию (и старую папку, если имя изменилось) — чтобы не остался устаревший .dds кэш
    let prev = with_state(&app, &customs, |m| m.get(&livery.id).cloned())?;
    if let Some(p) = &prev {
        let _ = fs::remove_dir_all(liveries_dir(&customs).join(&p.folder));
        if let Some(cf) = &p.car_file {
            let _ = fs::remove_file(cars_dir(&customs).join(cf));
        }
    }
    let target = liveries_dir(&customs).join(&folder);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(err("Не удалось очистить старую папку скина (закройте ACC)"))?;
    }
    fs::create_dir_all(&target).map_err(err("Не удалось создать папку скина"))?;
    for (name, bytes, is_car) in &files {
        if !*is_car {
            fs::write(target.join(name.to_lowercase()), bytes).map_err(err(&format!("Запись {name}")))?;
        }
    }

    // конфиг машины → Cars\dobeg_<имя>.json в UTF-16 LE + BOM, как делает сама игра
    let mut car_file_name = None;
    if let Some(raw) = car_raw {
        let cname = format!("dobeg_{}.json", folder.replace(' ', "_"));
        let text = match parsed {
            Some((mut v, m)) => {
                if m.custom_skin_name.is_none() {
                    if let Some(o) = v.as_object_mut() {
                        o.insert("customSkinName".into(), Value::String(folder.clone()));
                    }
                }
                serde_json::to_string_pretty(&v).unwrap_or_else(|_| acc::decode_text(&raw))
            }
            None => acc::decode_text(&raw),
        };
        fs::write(cars_dir(&customs).join(&cname), acc::encode_utf16le_bom(&text)).map_err(err("Запись конфига машины"))?;
        car_file_name = Some(cname);
    }

    let inst = Installed { folder, car_file: car_file_name, sig: livery.sig.clone(), installed_at: now() };
    let ret = inst.clone();
    with_state(&app, &customs, move |m| {
        m.insert(livery.id, inst);
    })?;
    Ok(ret)
}

fn remove_installed(customs: &str, i: &Installed) {
    let _ = fs::remove_dir_all(liveries_dir(customs).join(&i.folder));
    if let Some(cf) = &i.car_file {
        let _ = fs::remove_file(cars_dir(customs).join(cf));
    }
}

#[tauri::command]
fn uninstall_livery(app: AppHandle, customs: String, id: String) -> Result<(), String> {
    with_state(&app, &customs, |m| {
        if let Some(i) = m.remove(&id) {
            remove_installed(&customs, &i);
        }
    })
}

/// Удаляет только то, что поставил лаунчер — собственные скины пилота не трогаем.
#[tauri::command]
fn uninstall_all(app: AppHandle, customs: String) -> Result<usize, String> {
    with_state(&app, &customs, |m| {
        let n = m.len();
        for (_, i) in m.drain() {
            remove_installed(&customs, &i);
        }
        n
    })
}

// ───────────────────────── Команды: сеть для фронтенда ─────────────────────────

/// Запасной путь загрузки картинок/моделей, если WebView вдруг заблокирует CORS.
#[tauri::command]
async fn fetch_b64(url: String) -> Result<String, String> {
    if !url.starts_with("https://raw.githubusercontent.com/") {
        return Err("Разрешены только raw.githubusercontent.com".into());
    }
    let r = http().get(&url).send().await.map_err(err("Сеть"))?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status()));
    }
    Ok(B64.encode(r.bytes().await.map_err(err("Чтение"))?))
}

// ───────────────────────── Команды: админка (GitHub REST) ─────────────────────────

/// POST на Worker с учётными данными администратора.
async fn worker_post(base: &str, key: &str, path: &str, body: Value) -> Result<Value, String> {
    // логин:пароль — в теле запроса, а не в заголовке: в HTTP-заголовках нельзя кириллицу
    let mut body = body;
    body["auth"] = Value::String(key.trim().to_string());
    let r = http().post(format!("{base}{path}")).json(&body).send().await.map_err(err("Сервер недоступен"))?;
    let st = r.status();
    let text = r.text().await.map_err(err("Чтение ответа"))?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !st.is_success() {
        return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("Сервер вернул {st}")));
    }
    Ok(v)
}

/// `token` — «логин:пароль» администратора, если задан Worker, иначе персональный токен GitHub.
#[tauri::command]
async fn github_check_token(token: String, worker: Option<String>) -> Result<Value, String> {
    if let Some(base) = worker_base(&worker) {
        let v = worker_post(&base, &token, "/check", json!({})).await?;
        return Ok(json!({ "login": v["name"].as_str().unwrap_or("admin"), "canPush": true }));
    }
    let t = Some(token);
    let r = gh_headers(http().get("https://api.github.com/user"), &t).send().await.map_err(err("Сеть"))?;
    let st = r.status();
    let body = r.text().await.map_err(err("Чтение"))?;
    if !st.is_success() {
        return Err(http_error(st, &body));
    }
    let login = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["login"].as_str().map(String::from)).unwrap_or_default();
    let r = gh_headers(http().get(format!("https://api.github.com/repos/{OWNER}/{REPO}")), &t)
        .send()
        .await
        .map_err(err("Сеть"))?;
    let st = r.status();
    let body = r.text().await.map_err(err("Чтение"))?;
    if !st.is_success() {
        return Err(http_error(st, &body));
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let can_push = v["permissions"]["push"].as_bool().unwrap_or(false);
    Ok(json!({ "login": login, "canPush": can_push }))
}

async fn current_sha(token: &Option<String>, path: &str) -> Result<Option<String>, String> {
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/contents/{}", enc_path(path));
    let r = gh_headers(http().get(url), token).send().await.map_err(err("Сеть"))?;
    let st = r.status();
    if st.as_u16() == 404 {
        return Ok(None);
    }
    let body = r.text().await.map_err(err("Чтение"))?;
    if !st.is_success() {
        return Err(http_error(st, &body));
    }
    Ok(serde_json::from_str::<Value>(&body).ok().and_then(|v| v["sha"].as_str().map(String::from)))
}

/// Загрузка файла на Worker сырыми байтами (без base64 на стороне сервера — экономит его процессорное время).
/// Большие модели передаются частями: `part`/`parts`, а `sha` и `size` описывают файл целиком.
async fn worker_put(base: &str, key: &str, path: &str, bytes: Vec<u8>, sha: &str, part: u32, parts: u32, size: u64) -> Result<Value, String> {
    let enc = |s: &str| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string();
    let r = http()
        .post(format!("{base}/put"))
        .header("x-auth", enc(key.trim()))
        .header("x-path", enc(path))
        .header("x-sha", sha)
        .header("x-part", part.to_string())
        .header("x-parts", parts.to_string())
        .header("x-size", size.to_string())
        .header("content-type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(err("Сервер недоступен"))?;
    let st = r.status();
    let text = r.text().await.map_err(err("Чтение ответа"))?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !st.is_success() {
        return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| format!("Сервер вернул {st}")));
    }
    Ok(v)
}

/// Создаёт или обновляет файл: через Worker (по логину и паролю) или напрямую `PUT /repos/{owner}/{repo}/contents/{path}`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn github_put_file(
    token: String,
    path: String,
    content_b64: String,
    message: String,
    worker: Option<String>,
    sha: Option<String>,
    part: Option<u32>,
    parts: Option<u32>,
    size: Option<u64>,
) -> Result<String, String> {
    if let Some(base) = worker_base(&worker) {
        let bytes = B64.decode(content_b64.as_bytes()).map_err(err("Некорректные данные файла"))?;
        let sha = sha.ok_or("Не передана контрольная сумма файла")?;
        let total = size.unwrap_or(bytes.len() as u64);
        worker_put(&base, &token, &path, bytes, &sha, part.unwrap_or(0), parts.unwrap_or(1), total).await?;
        return Ok(sha);
    }
    let t = Some(token);
    let sha = current_sha(&t, &path).await?;
    let mut body = json!({ "message": message, "content": content_b64 });
    if let Some(s) = sha {
        body["sha"] = Value::String(s);
    }
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/contents/{}", enc_path(&path));
    let r = gh_headers(http().put(url), &t).json(&body).send().await.map_err(err("Сеть"))?;
    let st = r.status();
    let text = r.text().await.map_err(err("Чтение"))?;
    if !st.is_success() {
        return Err(http_error(st, &text));
    }
    Ok(serde_json::from_str::<Value>(&text).ok().and_then(|v| v["content"]["sha"].as_str().map(String::from)).unwrap_or_default())
}

#[tauri::command]
async fn github_delete_file(token: String, path: String, message: String, worker: Option<String>) -> Result<(), String> {
    if let Some(base) = worker_base(&worker) {
        worker_post(&base, &token, "/delete", json!({ "path": path, "message": message })).await?;
        return Ok(());
    }
    let t = Some(token);
    let Some(sha) = current_sha(&t, &path).await? else { return Ok(()) };
    let url = format!("https://api.github.com/repos/{OWNER}/{REPO}/contents/{}", enc_path(&path));
    let r = gh_headers(http().delete(url), &t)
        .json(&json!({ "message": message, "sha": sha }))
        .send()
        .await
        .map_err(err("Сеть"))?;
    let st = r.status();
    if !st.is_success() {
        let text = r.text().await.unwrap_or_default();
        return Err(http_error(st, &text));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_customs_path,
            ensure_customs,
            open_folder,
            sync_remote,
            installed_state,
            install_livery,
            uninstall_livery,
            uninstall_all,
            fetch_b64,
            github_check_token,
            github_put_file,
            github_delete_file,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска DOBEG Launcher");
}
