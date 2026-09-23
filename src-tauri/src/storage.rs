use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CONFIG_DIRECTORY: &str = ".nomi";
const CONFIG_FILENAME: &str = "config.json";
const LOCATOR_FILENAME: &str = "storage-location.json";
const SCHEMA_VERSION: u32 = 1;
const FEATURES: [(&str, &str); 6] = [
    ("chat", "chat"),
    ("notes", "notes"),
    ("todo", "todo"),
    ("travel", "travel"),
    ("history", "history"),
    ("finance", "finance"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageConfig {
    schema_version: u32,
    app: String,
    created_at: u64,
    feature_directories: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageLocator {
    root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureDirectory {
    id: String,
    name: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    root_path: String,
    config_path: String,
    reused_existing_data: bool,
    features: Vec<FeatureDirectory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    total_bytes: u64,
}

#[tauri::command]
pub fn get_storage_status(app: AppHandle) -> Result<Option<StorageStatus>, String> {
    let locator_path = locator_path(&app)?;

    if !locator_path.exists() {
        return Ok(None);
    }

    let locator: StorageLocator = read_json(&locator_path)
        .map_err(|error| format!("无法读取存储位置记录 {}：{error}", locator_path.display()))?;
    let root = PathBuf::from(locator.root_path);

    if !root.is_dir() {
        return Ok(None);
    }

    prepare_storage(&root).map(Some)
}

#[tauri::command]
pub fn set_storage_root(app: AppHandle, root_path: String) -> Result<StorageStatus, String> {
    let requested_root = PathBuf::from(root_path.trim());

    if !requested_root.is_dir() {
        return Err("请选择一个已经存在的文件夹。".into());
    }

    let canonical_root = drop_verbatim_prefix(
        requested_root
            .canonicalize()
            .map_err(|error| format!("无法访问所选文件夹：{error}"))?,
    );
    let status = prepare_storage(&canonical_root)?;
    let locator_path = locator_path(&app)?;

    if let Some(parent) = locator_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Nomi 本地配置目录：{error}"))?;
    }

    write_json(
        &locator_path,
        &StorageLocator {
            root_path: path_string(&canonical_root),
        },
    )
    .map_err(|error| format!("无法保存当前存储位置：{error}"))?;

    Ok(status)
}

/// Calculate the logical size of every regular file under the current Nomi
/// data folder. The traversal runs off the async worker thread so a large photo
/// or chat archive cannot freeze the settings UI.
#[tauri::command]
pub async fn get_storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let root = current_root(&app)?;
    tokio::task::spawn_blocking(move || {
        directory_size(&root).map(|total_bytes| StorageUsage { total_bytes })
    })
    .await
    .map_err(|error| format!("存储空间统计任务失败：{error}"))?
}

/// Resolve the currently configured data-folder root, or an error if the user
/// has not chosen one yet (or it is currently unavailable). Used by feature
/// modules (e.g. chat) that need to read/write under the data folder.
pub fn current_root(app: &AppHandle) -> Result<PathBuf, String> {
    let locator_path = locator_path(app)?;
    if !locator_path.exists() {
        return Err("尚未选择 Nomi 数据文件夹。".into());
    }
    let locator: StorageLocator =
        read_json(&locator_path).map_err(|error| format!("无法读取存储位置记录：{error}"))?;
    let root = PathBuf::from(locator.root_path);
    if !root.is_dir() {
        return Err("数据文件夹当前不可用，请在设置中重新选择。".into());
    }
    Ok(root)
}

fn locator_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(LOCATOR_FILENAME))
        .map_err(|error| format!("无法定位 Nomi 本地配置目录：{error}"))
}

fn prepare_storage(root: &Path) -> Result<StorageStatus, String> {
    let config_directory = root.join(CONFIG_DIRECTORY);
    let config_path = config_directory.join(CONFIG_FILENAME);
    let reused_existing_data = config_path.exists()
        || FEATURES
            .iter()
            .any(|(_, directory)| root.join(directory).exists());

    fs::create_dir_all(&config_directory)
        .map_err(|error| format!("无法创建 {}：{error}", config_directory.display()))?;

    let config = if config_path.exists() {
        read_json::<StorageConfig>(&config_path).map_err(|error| {
            format!(
                "已有 Nomi 配置无法读取，为保护数据没有覆盖它。文件：{}；错误：{error}",
                config_path.display()
            )
        })?
    } else {
        let config = default_config();
        write_json(&config_path, &config)
            .map_err(|error| format!("无法创建 {}：{error}", config_path.display()))?;
        config
    };

    if config.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "该文件夹使用了更新版本的 Nomi 数据格式（版本 {}），当前应用仅支持版本 {}。",
            config.schema_version, SCHEMA_VERSION
        ));
    }

    let features = FEATURES
        .iter()
        .map(|(id, default_directory)| {
            let directory_name = config
                .feature_directories
                .get(*id)
                .map(String::as_str)
                .unwrap_or(default_directory);
            let path = feature_path(root, directory_name)?;

            fs::create_dir_all(&path)
                .map_err(|error| format!("无法创建 {}：{error}", path.display()))?;

            Ok(FeatureDirectory {
                id: (*id).to_string(),
                name: directory_name.to_string(),
                path: path_string(&path),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(StorageStatus {
        root_path: path_string(root),
        config_path: path_string(&config_path),
        reused_existing_data,
        features,
    })
}

/// Windows `canonicalize` returns extended-length ("verbatim") paths like
/// `\\?\C:\Users\me\Nomi` (or `\\?\UNC\server\share` for network shares). Those
/// display badly in the UI and confuse some external tooling, so strip the
/// prefix for a clean, human-readable path. Only done when the result stays
/// comfortably under the Windows MAX_PATH (260) budget, since dropping the
/// prefix also drops long-path support for the child folders we create below.
/// No-op for paths that don't carry the prefix (all Unix paths).
fn drop_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        let candidate = format!(r"\\{rest}");
        if candidate.len() < 240 {
            return PathBuf::from(candidate);
        }
    } else if let Some(rest) = text.strip_prefix(r"\\?\")
        && rest.len() < 240
    {
        return PathBuf::from(rest.to_string());
    }
    path
}

fn feature_path(root: &Path, directory_name: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(directory_name).components();
    let is_single_directory = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && directory_name != CONFIG_DIRECTORY;

    if !is_single_directory {
        return Err(format!(
            "配置中的功能目录名称不安全：{directory_name}。目录必须是数据文件夹下的单层文件夹。"
        ));
    }

    Ok(root.join(directory_name))
}

fn directory_size(root: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("无法读取数据文件夹 {}：{error}", directory.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("无法读取数据文件夹 {}：{error}", directory.display()))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("无法读取文件类型 {}：{error}", entry.path().display()))?;
            if file_type.is_symlink() {
                // Do not follow links out of the selected data folder or enter
                // a recursive link cycle.
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                let size = entry
                    .metadata()
                    .map_err(|error| format!("无法读取文件 {}：{error}", entry.path().display()))?
                    .len();
                total = total.saturating_add(size);
            }
        }
    }
    Ok(total)
}

fn default_config() -> StorageConfig {
    StorageConfig {
        schema_version: SCHEMA_VERSION,
        app: "Nomi".to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        feature_directories: FEATURES
            .iter()
            .map(|(id, directory)| ((*id).to_string(), (*directory).to_string()))
            .collect(),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    contents.push('\n');
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nomi-{name}-{unique}"))
    }

    #[test]
    fn initializes_an_empty_storage_root() {
        let root = test_root("empty");
        fs::create_dir_all(&root).unwrap();

        let status = prepare_storage(&root).unwrap();

        assert!(!status.reused_existing_data);
        assert!(root.join(".nomi/config.json").is_file());
        for (_, directory) in FEATURES {
            assert!(root.join(directory).is_dir());
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_existing_feature_data() {
        let root = test_root("existing");
        let chat = root.join("chat");
        fs::create_dir_all(&chat).unwrap();
        let existing_file = chat.join("existing.json");
        fs::write(&existing_file, "{}\n").unwrap();

        let status = prepare_storage(&root).unwrap();

        assert!(status.reused_existing_data);
        assert_eq!(fs::read_to_string(existing_file).unwrap(), "{}\n");
        assert!(root.join(".nomi/config.json").is_file());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn totals_every_file_in_the_data_folder() {
        let root = test_root("usage");
        fs::create_dir_all(root.join("chat/assets")).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("chat/messages.json"), b"12345").unwrap();
        fs::write(root.join("chat/assets/photo.png"), b"1234567").unwrap();
        fs::write(root.join("notes/note.md"), b"123").unwrap();

        assert_eq!(directory_size(&root).unwrap(), 15);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drops_windows_verbatim_prefix() {
        assert_eq!(
            drop_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\me\Nomi Data")),
            PathBuf::from(r"C:\Users\me\Nomi Data")
        );
        assert_eq!(
            drop_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\Nomi")),
            PathBuf::from(r"\\server\share\Nomi")
        );
        // Unix paths (and anything without the prefix) pass through untouched.
        let unix = PathBuf::from("/Users/me/Nomi Data");
        assert_eq!(drop_verbatim_prefix(unix.clone()), unix);
    }

    #[test]
    fn rejects_feature_directories_outside_the_storage_root() {
        let root = test_root("unsafe-config");
        fs::create_dir_all(root.join(CONFIG_DIRECTORY)).unwrap();
        let mut config = default_config();
        config
            .feature_directories
            .insert("chat".into(), "../outside".into());
        write_json(&root.join(CONFIG_DIRECTORY).join(CONFIG_FILENAME), &config).unwrap();

        let error = prepare_storage(&root).unwrap_err();

        assert!(error.contains("目录名称不安全"));
        fs::remove_dir_all(root).unwrap();
    }
}
