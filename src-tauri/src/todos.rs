use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use crate::storage;

const TODO_DIR: &str = "todo";
const TODO_FILE: &str = "todos.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_TITLE: usize = 200;
const MAX_NOTES: usize = 4000;

// Data layout under the user's data folder — one plain, portable, human-readable
// file so the whole list can be diffed, synced or edited by hand:
//
//   todo/
//     todos.json    { "schemaVersion": 1, "todos": [ … ] }
//
// A todo carries its Eisenhower quadrant (1–4) and an optional local-calendar due
// date (`YYYY-MM-DD`). Both views the UI offers — the four-quadrant board and the
// per-day list — are just different groupings of this one array, so a todo never
// has to be moved between files when its date or quadrant changes.

/// One todo item. `quadrant` is the Eisenhower cell:
/// 1 = 重要且紧急, 2 = 重要不紧急, 3 = 紧急不重要, 4 = 不重要不紧急.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    id: String,
    title: String,
    #[serde(default)]
    notes: String,
    quadrant: u8,
    /// `YYYY-MM-DD` in the user's local calendar, or `None` for "someday".
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    completed_at: Option<u64>,
    created_at: u64,
    updated_at: u64,
    /// Manual sort key inside a quadrant, ascending. Rewritten as 0..n by
    /// `reorder_todos`; new items land after the current maximum.
    order: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodoFile {
    schema_version: u32,
    todos: Vec<Todo>,
}

/// Partial update. Every field is optional: absent means "leave unchanged".
/// `due_date` is doubly optional so the UI can distinguish "don't touch" (absent)
/// from "clear the date" (`null`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    title: Option<String>,
    notes: Option<String>,
    quadrant: Option<u8>,
    #[serde(default, deserialize_with = "some_option")]
    due_date: Option<Option<String>>,
    done: Option<bool>,
}

/// Distinguishes an explicit JSON `null` from an absent key (serde maps both to
/// `None` without this): present-and-null becomes `Some(None)`.
fn some_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn todo_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(TODO_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 todo 目录：{error}"))?;
    Ok(dir)
}

fn todo_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(todo_root(app)?.join(TODO_FILE))
}

/// Read the list, tolerating a missing file (first run) but not a corrupt one —
/// refusing to start from scratch is what keeps a bad parse from wiping the data.
fn load(app: &AppHandle) -> Result<Vec<Todo>, String> {
    let path = todo_file(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取待办数据：{error}"))?;
    let file: TodoFile = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "待办数据无法解析，为保护数据没有覆盖它。文件：{}；错误：{error}",
            path.display()
        )
    })?;
    if file.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "待办数据使用了更新版本的格式（版本 {}），当前应用仅支持版本 {SCHEMA_VERSION}。",
            file.schema_version
        ));
    }
    Ok(file.todos)
}

fn save(app: &AppHandle, todos: &[Todo]) -> Result<(), String> {
    let path = todo_file(app)?;
    let file = TodoFile {
        schema_version: SCHEMA_VERSION,
        todos: todos.to_vec(),
    };
    let mut contents =
        serde_json::to_string_pretty(&file).map_err(|error| format!("无法序列化待办：{error}"))?;
    contents.push('\n');
    // Write-then-rename so a crash mid-write cannot truncate the real list.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法保存待办数据：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法保存待办数据：{error}"))
}

fn clean_title(title: &str) -> Result<String, String> {
    let trimmed: String = title.trim().chars().take(MAX_TITLE).collect();
    if trimmed.trim().is_empty() {
        return Err("待办内容不能为空。".into());
    }
    Ok(trimmed.trim().to_string())
}

fn check_quadrant(quadrant: u8) -> Result<u8, String> {
    if (1..=4).contains(&quadrant) {
        Ok(quadrant)
    } else {
        Err("象限必须是 1 到 4。".into())
    }
}

/// Accept only a plain `YYYY-MM-DD` calendar date so the stored file stays
/// unambiguous (the frontend formats the user's local date; no timezone here).
fn check_due_date(date: Option<String>) -> Result<Option<String>, String> {
    let Some(date) = date else {
        return Ok(None);
    };
    let date = date.trim().to_string();
    if date.is_empty() {
        return Ok(None);
    }
    let bytes = date.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !shaped {
        return Err("日期格式必须是 YYYY-MM-DD。".into());
    }
    Ok(Some(date))
}

/// Sort key for the UI: unfinished first, then the manual order, then creation
/// time as a stable tie-break for items that have never been reordered.
fn sorted(mut todos: Vec<Todo>) -> Vec<Todo> {
    todos.sort_by(|a, b| {
        a.done
            .cmp(&b.done)
            .then(a.order.cmp(&b.order))
            .then(a.created_at.cmp(&b.created_at))
    });
    todos
}

fn next_order(todos: &[Todo], quadrant: u8) -> i64 {
    todos
        .iter()
        .filter(|todo| todo.quadrant == quadrant)
        .map(|todo| todo.order)
        .max()
        .map_or(0, |max| max.saturating_add(1))
}

fn find_index(todos: &[Todo], id: &str) -> Result<usize, String> {
    todos
        .iter()
        .position(|todo| todo.id == id)
        .ok_or_else(|| "待办不存在。".to_string())
}

#[tauri::command]
pub fn todos_list(app: AppHandle) -> Result<Vec<Todo>, String> {
    Ok(sorted(load(&app)?))
}

#[tauri::command]
pub fn create_todo(
    app: AppHandle,
    title: String,
    quadrant: u8,
    due_date: Option<String>,
) -> Result<Todo, String> {
    let title = clean_title(&title)?;
    let quadrant = check_quadrant(quadrant)?;
    let due_date = check_due_date(due_date)?;
    let mut todos = load(&app)?;
    let timestamp = now();
    let todo = Todo {
        id: format!("todo-{}", uuid::Uuid::new_v4()),
        title,
        notes: String::new(),
        quadrant,
        due_date,
        done: false,
        completed_at: None,
        created_at: timestamp,
        updated_at: timestamp,
        order: next_order(&todos, quadrant),
    };
    todos.push(todo.clone());
    save(&app, &todos)?;
    Ok(todo)
}

#[tauri::command]
pub fn update_todo(app: AppHandle, id: String, patch: TodoPatch) -> Result<Todo, String> {
    let mut todos = load(&app)?;
    let index = find_index(&todos, &id)?;

    if let Some(title) = patch.title {
        todos[index].title = clean_title(&title)?;
    }
    if let Some(notes) = patch.notes {
        todos[index].notes = notes.chars().take(MAX_NOTES).collect();
    }
    if let Some(quadrant) = patch.quadrant {
        let quadrant = check_quadrant(quadrant)?;
        if quadrant != todos[index].quadrant {
            // Land at the end of the target quadrant so the move is predictable.
            todos[index].order = next_order(&todos, quadrant);
            todos[index].quadrant = quadrant;
        }
    }
    if let Some(due_date) = patch.due_date {
        todos[index].due_date = check_due_date(due_date)?;
    }
    if let Some(done) = patch.done {
        todos[index].done = done;
        todos[index].completed_at = if done { Some(now()) } else { None };
    }
    todos[index].updated_at = now();

    let updated = todos[index].clone();
    save(&app, &todos)?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_todo(app: AppHandle, id: String) -> Result<(), String> {
    let mut todos = load(&app)?;
    let index = find_index(&todos, &id)?;
    todos.remove(index);
    save(&app, &todos)
}

/// Rewrite the manual order of one quadrant from the id list the UI dragged into
/// shape. Ids that are missing or belong elsewhere are ignored; todos in the
/// quadrant that the list omits keep their relative order after the listed ones.
#[tauri::command]
pub fn reorder_todos(app: AppHandle, quadrant: u8, ids: Vec<String>) -> Result<Vec<Todo>, String> {
    let quadrant = check_quadrant(quadrant)?;
    let mut todos = load(&app)?;
    let mut next: i64 = 0;
    for id in &ids {
        if let Some(todo) = todos
            .iter_mut()
            .find(|todo| todo.id == *id && todo.quadrant == quadrant)
        {
            todo.order = next;
            next += 1;
        }
    }
    for todo in todos.iter_mut() {
        if todo.quadrant == quadrant && !ids.contains(&todo.id) {
            todo.order = next;
            next += 1;
        }
    }
    save(&app, &todos)?;
    Ok(sorted(todos))
}

/// Delete every finished todo. Returns how many were removed.
#[tauri::command]
pub fn clear_done_todos(app: AppHandle) -> Result<usize, String> {
    let todos = load(&app)?;
    let before = todos.len();
    let kept: Vec<Todo> = todos.into_iter().filter(|todo| !todo.done).collect();
    let removed = before - kept.len();
    if removed > 0 {
        save(&app, &kept)?;
    }
    Ok(removed)
}

/// Absolute path of the todo data file, for "reveal in Finder / Explorer".
#[tauri::command]
pub fn todo_reveal_path(app: AppHandle) -> Result<String, String> {
    let path = todo_file(&app)?;
    if !path.exists() {
        save(&app, &[])?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(id: &str, quadrant: u8, order: i64, done: bool) -> Todo {
        Todo {
            id: id.to_string(),
            title: id.to_string(),
            notes: String::new(),
            quadrant,
            due_date: None,
            done,
            completed_at: None,
            created_at: 1,
            updated_at: 1,
            order,
        }
    }

    #[test]
    fn sorts_unfinished_first_then_by_manual_order() {
        let sorted = sorted(vec![
            todo("c", 1, 0, true),
            todo("b", 1, 2, false),
            todo("a", 1, 1, false),
        ]);
        let ids: Vec<&str> = sorted.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn next_order_is_per_quadrant() {
        let todos = vec![todo("a", 1, 7, false), todo("b", 2, 3, false)];
        assert_eq!(next_order(&todos, 1), 8);
        assert_eq!(next_order(&todos, 2), 4);
        assert_eq!(next_order(&todos, 3), 0);
    }

    #[test]
    fn validates_due_dates_and_quadrants() {
        assert_eq!(
            check_due_date(Some("2026-08-28".into())).unwrap(),
            Some("2026-08-28".to_string())
        );
        assert_eq!(check_due_date(Some("  ".into())).unwrap(), None);
        assert!(check_due_date(Some("28/08/2026".into())).is_err());
        assert!(check_quadrant(0).is_err());
        assert!(check_quadrant(5).is_err());
        assert_eq!(check_quadrant(4).unwrap(), 4);
    }

    #[test]
    fn rejects_blank_titles_and_caps_long_ones() {
        assert!(clean_title("   ").is_err());
        assert_eq!(clean_title("  写周报  ").unwrap(), "写周报");
        assert_eq!(clean_title(&"字".repeat(300)).unwrap().chars().count(), 200);
    }

    #[test]
    fn patch_distinguishes_absent_from_null_due_date() {
        let untouched: TodoPatch = serde_json::from_str(r#"{"done":true}"#).unwrap();
        assert!(untouched.due_date.is_none());
        let cleared: TodoPatch = serde_json::from_str(r#"{"dueDate":null}"#).unwrap();
        assert_eq!(cleared.due_date, Some(None));
        let set: TodoPatch = serde_json::from_str(r#"{"dueDate":"2026-08-28"}"#).unwrap();
        assert_eq!(set.due_date, Some(Some("2026-08-28".to_string())));
    }
}
