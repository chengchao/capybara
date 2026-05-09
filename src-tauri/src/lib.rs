use std::time::Duration;

use tauri::RunEvent;

mod commands;
mod vm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            vm::get_vm_status,
            vm::create_session,
            vm::connect_directory,
            vm::run_as_session,
            vm::delete_session,
        ])
        .manage(vm::VmState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = vm::ensure_vm(&handle).await {
                    eprintln!("vm: failed: {e}");
                    vm::emit_status(
                        &handle,
                        vm::VmStatus::Failed {
                            reason: e.to_string(),
                        },
                    );
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit) {
            let handle = handle.clone();
            tauri::async_runtime::block_on(async move {
                let _ = tokio::time::timeout(Duration::from_secs(10), vm::stop_vm(&handle)).await;
            });
        }
    });
}
