mod chat;
mod chat_agent;
mod exa;
mod finance;
mod llm;
mod mcp;
mod notes;
mod papers;
mod pdf;
mod providers;
mod storage;
mod todos;
mod travel;
mod windowing;

use chat::{
    add_context_marker, create_assistant, create_conversation, create_default_conversation,
    delete_assistant, delete_chat_message, delete_conversation, edit_chat_message,
    get_chat_settings, list_all_conversations, list_assistants, list_conversations, list_messages,
    rename_conversation, reveal_conversation, set_chat_message_feedback, set_chat_settings,
    set_conversation_assistant, set_conversation_model, set_default_conversation_settings,
    set_response_group_state, update_assistant,
};
use chat_agent::{
    ChatCancels, RenderJobs, generate_message_variant, read_chat_attachment_data,
    read_pdf_thumbnail, save_chat_attachment, save_chat_attachment_data, send_message,
    stop_message, submit_render_result, write_attachment_to,
};
use exa::{exa_get_status, exa_set_key};
use finance::{
    finance_add_record, finance_capture, finance_capture_file, finance_clear_messages,
    finance_confirm_drafts, finance_delete_record, finance_find_duplicates, finance_list_messages,
    finance_list_months, finance_list_records, finance_read_receipt, finance_reveal_path,
    finance_set_model, finance_status, finance_update_record,
};
use mcp::{mcp_get_client_config, mcp_get_status, mcp_set_enabled};
use notes::{
    create_folder, create_note, delete_folder, delete_note, move_node, note_reveal_path,
    notes_tree, read_note, read_note_assets, rename_folder, rename_note, save_note,
    save_note_image,
};
use papers::{
    PapersState, papers_add_edge, papers_create_paper, papers_delete_edge, papers_delete_paper,
    papers_load_graph, papers_move_paper, papers_read_assets, papers_read_body, papers_reveal,
    papers_save_body, papers_save_image, papers_update_edge, papers_update_edge_sides,
    papers_update_paper,
};
use providers::{
    create_provider, delete_provider, fetch_provider_models, list_providers, provider_balance,
    provider_has_key, set_default_model, set_provider_enabled, set_provider_key, test_provider,
    update_provider,
};
use storage::{get_storage_status, set_storage_root};
use todos::{
    clear_done_todos, create_todo, delete_todo, reorder_todos, todo_reveal_path, todos_list,
    update_todo,
};
use travel::{
    travel_create_note, travel_create_plan, travel_delete_map, travel_delete_note,
    travel_delete_plan, travel_download_map, travel_get_settings, travel_import_map,
    travel_list_maps, travel_list_notes, travel_list_plans, travel_map_read_range,
    travel_read_note, travel_read_note_assets, travel_reveal, travel_reveal_maps, travel_save_note,
    travel_save_note_image, travel_save_plan, travel_set_settings, travel_update_map,
    travel_update_note,
};
use windowing::{PendingTabs, open_tab_window, take_tab_payload};

/// CLI flag that runs the MCP stdio server instead of the GUI.
pub const MCP_STDIO_FLAG: &str = mcp::STDIO_FLAG;

/// Serve MCP over stdin/stdout. Returns a process exit code. Called from `main`
/// when the binary is launched with [`MCP_STDIO_FLAG`].
pub fn run_mcp_stdio() -> i32 {
    mcp::run_stdio()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ChatCancels::default())
        .manage(RenderJobs::default())
        .manage(PapersState::default())
        .manage(PendingTabs::default())
        .invoke_handler(tauri::generate_handler![
            get_storage_status,
            set_storage_root,
            list_assistants,
            create_assistant,
            update_assistant,
            delete_assistant,
            list_conversations,
            list_all_conversations,
            create_conversation,
            create_default_conversation,
            get_chat_settings,
            set_chat_settings,
            set_default_conversation_settings,
            rename_conversation,
            delete_conversation,
            reveal_conversation,
            set_conversation_assistant,
            set_conversation_model,
            list_messages,
            add_context_marker,
            edit_chat_message,
            set_chat_message_feedback,
            set_response_group_state,
            delete_chat_message,
            save_chat_attachment,
            save_chat_attachment_data,
            read_chat_attachment_data,
            read_pdf_thumbnail,
            send_message,
            generate_message_variant,
            stop_message,
            submit_render_result,
            write_attachment_to,
            list_providers,
            create_provider,
            update_provider,
            set_default_model,
            set_provider_enabled,
            delete_provider,
            set_provider_key,
            provider_has_key,
            test_provider,
            fetch_provider_models,
            provider_balance,
            exa_get_status,
            exa_set_key,
            mcp_get_status,
            mcp_set_enabled,
            mcp_get_client_config,
            notes_tree,
            create_note,
            create_folder,
            read_note,
            save_note,
            rename_note,
            rename_folder,
            delete_note,
            delete_folder,
            move_node,
            save_note_image,
            read_note_assets,
            note_reveal_path,
            papers_load_graph,
            papers_create_paper,
            papers_update_paper,
            papers_move_paper,
            papers_delete_paper,
            papers_read_body,
            papers_save_body,
            papers_add_edge,
            papers_update_edge,
            papers_update_edge_sides,
            papers_delete_edge,
            papers_save_image,
            papers_read_assets,
            papers_reveal,
            todos_list,
            create_todo,
            update_todo,
            delete_todo,
            reorder_todos,
            clear_done_todos,
            todo_reveal_path,
            finance_status,
            finance_set_model,
            finance_list_months,
            finance_list_records,
            finance_list_messages,
            finance_clear_messages,
            finance_capture,
            finance_capture_file,
            finance_confirm_drafts,
            finance_add_record,
            finance_update_record,
            finance_delete_record,
            finance_find_duplicates,
            finance_read_receipt,
            finance_reveal_path,
            travel_list_notes,
            travel_create_note,
            travel_read_note,
            travel_save_note,
            travel_update_note,
            travel_delete_note,
            travel_save_note_image,
            travel_read_note_assets,
            travel_reveal,
            travel_list_plans,
            travel_create_plan,
            travel_save_plan,
            travel_delete_plan,
            travel_get_settings,
            travel_set_settings,
            travel_list_maps,
            travel_import_map,
            travel_download_map,
            travel_update_map,
            travel_delete_map,
            travel_map_read_range,
            travel_reveal_maps,
            open_tab_window,
            take_tab_payload
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nomi");
}
