#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod repository;
#[cfg(test)]
mod tests;

use repository::{
    Commit, Context, Document, FileContent, FileEntry, FileSearch, Mode, Opened, Repository,
    Result, Snapshot,
};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct AppState(Mutex<Option<Repository>>);

fn with_repo<T>(
    state: &AppState,
    root: &str,
    operation: impl FnOnce(&Repository) -> Result<T>,
) -> Result<T> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let repo = guard.as_ref().ok_or("Open a repository first.")?;
    if repo.root_string() != root {
        return Err("The opened repository has changed. Please refresh.".into());
    }
    operation(repo)
}

#[tauri::command]
fn startup_path() -> Option<String> {
    resolve_startup_path(std::env::args_os().nth(1))
}

fn resolve_startup_path(argument: Option<std::ffi::OsString>) -> Option<String> {
    argument
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.into_os_string())
        })
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_repository(state: State<'_, AppState>, path: String) -> Result<Opened> {
    let repo = Repository::open(&path)?;
    let opened = repo.opened()?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(repo);
    Ok(opened)
}

#[tauri::command]
async fn list_commits(state: State<'_, AppState>, root: String) -> Result<Vec<Commit>> {
    with_repo(&state, &root, Repository::commits)
}

#[tauri::command]
async fn review_snapshot(
    state: State<'_, AppState>,
    root: String,
    mode: Mode,
    revision: Option<String>,
) -> Result<Snapshot> {
    with_repo(&state, &root, |repo| repo.snapshot(mode, revision))
}

#[tauri::command]
async fn list_folder(
    state: State<'_, AppState>,
    root: String,
    directory: String,
) -> Result<Vec<FileEntry>> {
    let repo = with_repo(&state, &root, |repo| Ok(repo.clone()))?;
    tauri::async_runtime::spawn_blocking(move || repo.folder_entries(&directory))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search_files(
    state: State<'_, AppState>,
    root: String,
    query: String,
) -> Result<FileSearch> {
    let repo = with_repo(&state, &root, |repo| Ok(repo.clone()))?;
    tauri::async_runtime::spawn_blocking(move || repo.search_files(&query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file(
    state: State<'_, AppState>,
    root: String,
    path: String,
    old_path: Option<String>,
    context: Context,
) -> Result<FileContent> {
    with_repo(&state, &root, |repo| {
        repo.content(&path, old_path.as_deref(), &context)
    })
}

#[tauri::command]
async fn save_comments(state: State<'_, AppState>, document: Document) -> Result<Vec<String>> {
    with_repo(&state, &document.root, |repo| repo.save(&document))
}

#[tauri::command]
fn comments_markdown(state: State<'_, AppState>, document: Document) -> Result<String> {
    with_repo(&state, &document.root, |_| {
        Ok(repository::render_markdown(&document))
    })
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            startup_path,
            open_repository,
            list_commits,
            review_snapshot,
            list_folder,
            search_files,
            read_file,
            save_comments,
            comments_markdown
        ])
        .run(tauri::generate_context!())
        .expect("failed to run agentic-review");
}
