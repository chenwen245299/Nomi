//! Extra app windows, born from dragging a tab out of the titlebar.
//!
//! A torn-off window is just another instance of the same frontend: it reads the
//! data folder like every other window, so the only thing that has to travel is
//! the tab's view state (which section, which conversation / note / …). That
//! JSON waits here under the new window's label until the fresh webview claims
//! it on its first paint — routing it through the URL instead would leave the
//! state in the address the window reloads with.

use std::{collections::HashMap, sync::Mutex};

use tauri::{AppHandle, State, WebviewWindowBuilder};
use uuid::Uuid;

/// Label prefix for torn-off windows. The frontend checks it before asking for a
/// payload, and `capabilities/default.json` grants these windows the main
/// window's permissions through the matching `tab-*` glob.
const DETACHED_LABEL_PREFIX: &str = "tab-";

/// Tab state handed to windows that have not claimed it yet, keyed by label.
#[derive(Default)]
pub struct PendingTabs(Mutex<HashMap<String, String>>);

/// Opens a window showing `payload` (one serialized tab) at the drop point.
/// `x`/`y` are the new window's top-left and `width`/`height` its inner size,
/// all in logical pixels, so it lands under the cursor at the size of the window
/// the tab came from. Returns the new window's label.
///
/// Building a window waits on the main thread, so the command has to be async —
/// a blocking one deadlocks the caller's webview on Windows.
#[tauri::command]
pub async fn open_tab_window(
    app: AppHandle,
    pending: State<'_, PendingTabs>,
    payload: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    // Inherit the main window's chrome (overlay titlebar, traffic-light offset,
    // minimum size, background) from tauri.conf.json rather than restating it.
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "缺少窗口配置".to_string())?;
    let label = format!("{DETACHED_LABEL_PREFIX}{}", Uuid::new_v4().simple());
    config.label = label.clone();
    config.center = false;
    config.x = x;
    config.y = y;
    if let Some(width) = width {
        config.width = width;
    }
    if let Some(height) = height {
        config.height = height;
    }

    pending
        .0
        .lock()
        .map_err(|_| "窗口状态不可用".to_string())?
        .insert(label.clone(), payload);

    match WebviewWindowBuilder::from_config(&app, &config).and_then(|builder| builder.build()) {
        Ok(_) => Ok(label),
        Err(error) => {
            // Nothing will ever claim this payload — don't leak it.
            if let Ok(mut pending) = pending.0.lock() {
                pending.remove(&label);
            }
            Err(error.to_string())
        }
    }
}

/// Claims the tab state stored for `label`. `None` for the main window, and for
/// a torn-off window that reloaded (its payload was taken by the first load).
#[tauri::command]
pub fn take_tab_payload(pending: State<'_, PendingTabs>, label: String) -> Option<String> {
    pending.0.lock().ok()?.remove(&label)
}
