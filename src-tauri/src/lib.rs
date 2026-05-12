use std::time::Duration;

use tauri::RunEvent;

mod agent;
mod commands;
mod vm;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            vm::get_vm_status,
            vm::create_session,
            vm::connect_directory,
            vm::delete_session,
            agent::start_agent_task,
        ])
        .manage(agent::AgentState::default())
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
                agent::stop_agent(&handle).await;
                vm::stop_supervisor(&handle).await;
                let _ = tokio::time::timeout(Duration::from_secs(10), vm::stop_vm(&handle)).await;
            });
        }
    });
}
