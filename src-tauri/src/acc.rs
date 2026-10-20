//! Чистая логика без Tauri: кодировки ACC-json, разбор дерева GitHub, фильтры файлов.
//! Вынесена отдельно, чтобы её можно было тестировать через `cargo test`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Файлы, которые реально нужны игре в `Customs\Liveries\<Skin>\`
pub const SKIN_FILES: [&str; 4] = ["decals.png", "sponsors.png", "decals.json", "sponsors.json"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CarMeta {
    pub car_model_type: Option<i64>,
    pub race_number: Option<i64>,
    pub custom_skin_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Livery {
    pub id: String,
    pub team: String,
    pub name: String,
    pub files: Vec<RemoteFile>,
    pub junk_count: usize,
    pub junk_paths: Vec<String>,
    pub sig: String,
    pub car_file: Option<RemoteFile>,
    /// preview.webp — 3D-обложка, которую заливает админ-панель. В установку и sig не входит.
    #[serde(default)]
    pub preview: Option<RemoteFile>,
    #[serde(default)]
    pub meta: Option<CarMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub sha: String,
    #[serde(default)]
    pub size: Option<u64>,
}

// ───────────────────────── Кодировки ─────────────────────────

/// Декодирует текст ACC: UTF-16 LE/BE (с BOM или без) и UTF-8 (с BOM или без).
pub fn decode_text(bytes: &[u8]) -> String {
    let s = if bytes.starts_with(&[0xFF, 0xFE]) {
        utf16(&bytes[2..], true)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        utf16(&bytes[2..], false)
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else if bytes.len() >= 4 && bytes[0] != 0 && bytes[1] == 0 && bytes[3] == 0 {
        utf16(bytes, true) // UTF-16 LE без BOM: "{\0\n\0"
    } else if bytes.len() >= 4 && bytes[0] == 0 && bytes[1] != 0 && bytes[2] == 0 {
        utf16(bytes, false)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    s.trim_start_matches('\u{feff}').replace('\0', "")
}

fn utf16(bytes: &[u8], le: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Кодирует строку как UTF-16 LE с BOM — так ACC сам пишет файлы машин.
pub fn encode_utf16le_bom(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// Достаёт carModelType / raceNumber / customSkinName (без учёта регистра ключей).
pub fn parse_car_json(bytes: &[u8]) -> Option<(Value, CarMeta)> {
    let text = decode_text(bytes);
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let obj = v.as_object()?;
    let find = |key: &str| obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v);
    let meta = CarMeta {
        car_model_type: find("carModelType").and_then(as_i64),
        race_number: find("raceNumber").and_then(as_i64),
        custom_skin_name: find("customSkinName")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    Some((v, meta))
}

// ───────────────────────── Файлы и имена ─────────────────────────

fn ext_of(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// .dds / .psd / .bak — кэш игры и исходники редакторов. Никогда не качаем и не заливаем.
pub fn is_junk(name: &str) -> bool {
    matches!(ext_of(name).as_str(), "dds" | "psd" | "bak")
}

pub fn is_skin_file(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    SKIN_FILES.contains(&l.as_str())
}

/// Безопасное имя папки/файла для Windows.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    let reserved = ["con", "prn", "aux", "nul"];
    if cleaned.is_empty() || reserved.contains(&cleaned.to_ascii_lowercase().as_str()) {
        "livery".to_string()
    } else {
        cleaned
    }
}

/// Стабильный FNV-1a (std DefaultHasher не гарантирует стабильность между версиями).
pub fn fnv_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

// ───────────────────────── Разбор дерева GitHub ─────────────────────────

const GENERIC_ROOTS: [&str; 6] = ["liveries", "skins", "customs", "cars", "dobeg", "src"];

/// Находит ЛЮБУЮ папку с decals.png / sponsors.png, на любой глубине:
/// `Папка/файлы`, `Команда/Папка/файлы`, `liveries/Команда/Папка/файлы` …
pub fn parse_tree(entries: &[TreeEntry]) -> (Vec<Livery>, Vec<ModelFile>) {
    let mut dirs: BTreeMap<String, Vec<&TreeEntry>> = BTreeMap::new();
    let mut models = Vec::new();

    for e in entries.iter().filter(|e| e.kind == "blob") {
        let Some((dir, name)) = e.path.rsplit_once('/') else { continue };
        let first = dir.split('/').next().unwrap_or("").to_ascii_lowercase();
        if first == "models" {
            if matches!(ext_of(name).as_str(), "obj" | "glb" | "gltf") {
                models.push(ModelFile {
                    name: name.to_string(),
                    path: e.path.clone(),
                    sha: e.sha.clone(),
                    size: e.size.unwrap_or(0),
                });
            }
            continue;
        }
        if first.starts_with('.') {
            continue;
        }
        dirs.entry(dir.to_string()).or_default().push(e);
    }

    let mut liveries = Vec::new();
    for (dir, files) in dirs {
        let has_texture = files.iter().any(|f| {
            let n = f.path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
            n == "decals.png" || n == "sponsors.png"
        });
        if !has_texture {
            continue;
        }
        let segs: Vec<&str> = dir.split('/').collect();
        let name = segs[segs.len() - 1].to_string();
        let team = if segs.len() >= 2 && !GENERIC_ROOTS.contains(&segs[segs.len() - 2].to_ascii_lowercase().as_str())
        {
            segs[segs.len() - 2].to_string()
        } else {
            String::new()
        };

        let mut keep = Vec::new();
        let mut car_file: Option<RemoteFile> = None;
        let mut preview: Option<RemoteFile> = None;
        let mut junk: Vec<String> = Vec::new();
        for f in &files {
            let fname = f.path.rsplit('/').next().unwrap_or("").to_string();
            let rf = RemoteFile {
                name: fname.clone(),
                path: f.path.clone(),
                sha: f.sha.clone(),
                size: f.size.unwrap_or(0),
            };
            if fname.eq_ignore_ascii_case("preview.webp") {
                preview = Some(rf);
            } else if is_junk(&fname) {
                junk.push(f.path.clone());
            } else if is_skin_file(&fname) {
                keep.push(rf);
            } else if ext_of(&fname) == "json" {
                // любой другой json — конфиг машины; car_config.json в приоритете
                let better = match &car_file {
                    None => true,
                    Some(c) => fname.eq_ignore_ascii_case("car_config.json") && !c.name.eq_ignore_ascii_case("car_config.json"),
                };
                if better {
                    car_file = Some(rf);
                }
            }
        }
        keep.sort_by(|a, b| a.name.cmp(&b.name));

        let mut sig_src = String::new();
        for f in keep.iter().chain(car_file.iter()) {
            sig_src.push_str(&format!("{}:{};", f.name.to_ascii_lowercase(), f.sha));
        }
        liveries.push(Livery {
            id: dir.clone(),
            team,
            name,
            files: keep,
            junk_count: junk.len(),
            junk_paths: junk,
            sig: fnv_hex(&sig_src),
            car_file,
            preview,
            meta: None,
        });
    }
    liveries.sort_by(|a, b| (a.team.to_lowercase(), a.name.to_lowercase()).cmp(&(b.team.to_lowercase(), b.name.to_lowercase())));
    models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    (liveries, models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn te(path: &str) -> TreeEntry {
        TreeEntry { path: path.into(), kind: "blob".into(), sha: format!("sha_{path}"), size: Some(10) }
    }

    #[test]
    fn decodes_utf16le_bom_utf8_and_plain() {
        let json = "{\"carModelType\": 35, \"raceNumber\": 77, \"customSkinName\": \"Лига_77\"}";
        let u16 = encode_utf16le_bom(json);
        let (_, m) = parse_car_json(&u16).unwrap();
        assert_eq!(m.car_model_type, Some(35));
        assert_eq!(m.race_number, Some(77));
        assert_eq!(m.custom_skin_name.as_deref(), Some("Лига_77"));

        let mut u8bom = vec![0xEF, 0xBB, 0xBF];
        u8bom.extend_from_slice(json.as_bytes());
        assert_eq!(parse_car_json(&u8bom).unwrap().1.race_number, Some(77));
        assert_eq!(parse_car_json(json.as_bytes()).unwrap().1.car_model_type, Some(35));

        // UTF-16 LE без BOM
        let no_bom: Vec<u8> = json.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_car_json(&no_bom).unwrap().1.custom_skin_name.as_deref(), Some("Лига_77"));
    }

    #[test]
    fn tree_is_flexible_and_filters_junk() {
        let entries = vec![
            te("models/McLaren 720S GT3 Evo.obj"),
            te("models/Ferrari 296 GT3.glb"),
            te("TeamA/Skin One/decals.png"),
            te("TeamA/Skin One/sponsors.png"),
            te("TeamA/Skin One/decals_0.dds"),
            te("TeamA/Skin One/sponsors_1.dds"),
            te("TeamA/Skin One/car_config.json"),
            te("Root Skin/decals.png"),
            te("Root Skin/notes.psd"),
            te("TeamA/Skin One/preview.webp"),
            te("liveries/Команда/Скин/sponsors.png"),
            te("README.md"),
        ];
        let (l, m) = parse_tree(&entries);
        assert_eq!(m.len(), 2);
        assert_eq!(l.len(), 3);
        let a = l.iter().find(|x| x.name == "Skin One").unwrap();
        assert_eq!(a.team, "TeamA");
        assert_eq!(a.files.len(), 2);
        assert_eq!(a.junk_count, 2);
        assert!(a.car_file.is_some());
        assert!(a.preview.is_some());
        assert_eq!(a.junk_count, 2);
        let r = l.iter().find(|x| x.name == "Root Skin").unwrap();
        assert_eq!(r.team, "");
        assert_eq!(r.junk_count, 1);
        let c = l.iter().find(|x| x.name == "Скин").unwrap();
        assert_eq!(c.team, "Команда");
    }

    #[test]
    fn sanitize_and_junk() {
        assert_eq!(sanitize_name("a<b>:c?."), "a_b__c_");
        assert_eq!(sanitize_name("  "), "livery");
        assert!(is_junk("Decals_0.DDS") && is_junk("x.bak") && !is_junk("decals.png"));
    }
}
