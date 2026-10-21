//! Name the real WebView2 WASAPI sessions so Windows' mixer can identify Pulse.
//! No audio stream, device routing, volume or mute state is created or changed.

#[cfg(windows)]
mod platform {
    use std::{
        collections::{HashMap, HashSet},
        sync::{atomic::{AtomicBool, Ordering}, mpsc::{sync_channel, SyncSender}},
        time::Duration,
    };
    use windows::{
        core::{implement, w, Interface, PWSTR, Ref, Result, GUID, HSTRING},
        Win32::{
            Foundation::{CloseHandle, FILETIME, HANDLE},
            Media::Audio::{
                eRender, IAudioSessionControl, IAudioSessionControl2, IAudioSessionManager2,
                IAudioSessionNotification, IAudioSessionNotification_Impl, IMMDeviceEnumerator,
                MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
            },
            System::{
                Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                    CLSCTX_ALL, COINIT_MULTITHREADED},
                Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
                    PROCESSENTRY32W, TH32CS_SNAPPROCESS},
                SystemInformation::GetSystemTimeAsFileTime,
                Threading::{GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION},
            },
            UI::Shell::SetCurrentProcessExplicitAppUserModelID,
        },
    };

    // One application group across the local-player and signed-in VK WebViews.
    const GROUP: GUID = GUID::from_u128(0x53f6836c_5729_431f_b977_29d7c98e34b8);
    static STARTED: AtomicBool = AtomicBool::new(false);

    pub(super) fn prepare_process(identifier: &str) {
        // Establish this process' Shell identity before WebView2 is launched.
        // This is per-process metadata, not a registry or device preference.
        unsafe { let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(identifier)); }
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } }
    }

    // All Core Audio string getters allocate with CoTaskMemAlloc.
    unsafe fn take_string(value: Result<PWSTR>) -> Option<String> {
        let value = value.ok()?;
        let text = value.to_string().ok();
        CoTaskMemFree(Some(value.0.cast()));
        text
    }

    fn timestamp(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    fn inspect_process(pid: u32, existed_by: u64, require_webview: bool) -> Option<(Handle, u64)> {
        unsafe {
            let handle = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
            let (mut created, mut exited, mut kernel, mut user) =
                (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user).ok()?;
            let created = timestamp(created);
            // Reject a PID recycled between the census and opening this handle.
            if created > existed_by { return None; }
            if require_webview {
                let mut path = [0u16; 32768];
                let mut length = path.len() as u32;
                QueryFullProcessImageNameW(handle.0, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut length).ok()?;
                let path = String::from_utf16_lossy(&path[..length as usize]);
                if !path.rsplit('\\').next()?.eq_ignore_ascii_case("msedgewebview2.exe") { return None; }
            }
            Some((handle, created))
        }
    }

    #[derive(Clone, Copy)]
    struct Process { pid: u32, parent: u32, created: u64 }

    fn owned_processes(root: u32, created: u64, candidates: &[Process]) -> HashSet<u32> {
        let mut owned = HashMap::from([(root, created)]);
        loop {
            let before = owned.len();
            for entry in candidates {
                // A stale parent PID may have been reused by this application.
                // A genuine child can never be older than its current parent.
                if owned.get(&entry.parent).is_some_and(|parent| entry.created >= *parent) {
                    owned.insert(entry.pid, entry.created);
                }
            }
            if owned.len() == before { break; }
        }
        owned.into_keys().collect()
    }

    struct ProcessTree { owned: HashSet<u32>, _handles: Vec<Handle> }

    fn process_tree(root: u32) -> ProcessTree {
        let empty = || ProcessTree { owned: HashSet::new(), _handles: Vec::new() };
        unsafe {
            let snapshot_started = timestamp(GetSystemTimeAsFileTime());
            let Some((root_handle, created)) = inspect_process(root, snapshot_started, false) else { return empty(); };
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return empty(); };
            let snapshot = Handle(snapshot);
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut candidates = Vec::new();
            let mut handles = vec![root_handle];
            let mut next = Process32FirstW(snapshot.0, &mut entry);
            while next.is_ok() {
                let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                // Do not relabel audio from an importer or from another application.
                if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("msedgewebview2.exe") {
                    if let Some((handle, created)) = inspect_process(entry.th32ProcessID, snapshot_started, true) {
                        candidates.push(Process { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, created });
                        // Keep the exact process objects alive until branding finishes,
                        // so an unrelated process cannot acquire one of these PIDs.
                        handles.push(handle);
                    }
                }
                next = Process32NextW(snapshot.0, &mut entry);
            }
            ProcessTree { owned: owned_processes(root, created, &candidates), _handles: handles }
        }
    }

    #[implement(IAudioSessionNotification)]
    struct SessionCreated { wake: SyncSender<()> }
    impl IAudioSessionNotification_Impl for SessionCreated_Impl {
        fn OnSessionCreated(&self, _: Ref<IAudioSessionControl>) -> Result<()> {
            // Never run process enumeration or COM operations in the audio-service callback.
            let _ = self.wake.try_send(());
            Ok(())
        }
    }

    struct EndpointWatch { manager: IAudioSessionManager2, listener: IAudioSessionNotification }
    impl Drop for EndpointWatch {
        fn drop(&mut self) {
            unsafe { let _ = self.manager.UnregisterSessionNotification(&self.listener); }
        }
    }

    unsafe fn brand(session: &IAudioSessionControl, owned: &HashSet<u32>, icon: &HSTRING) -> Result<()> {
        let detailed: IAudioSessionControl2 = session.cast()?;
        if !owned.contains(&detailed.GetProcessId()?) { return Ok(()); }
        // Only write metadata when necessary; do not keep notifying the mixer.
        if take_string(session.GetDisplayName()).as_deref() != Some("VK Player") {
            session.SetDisplayName(w!("VK Player"), &GROUP)?;
        }
        if take_string(session.GetIconPath()).as_deref() != Some(icon.to_string_lossy().as_str()) {
            session.SetIconPath(icon, &GROUP)?;
        }
        if session.GetGroupingParam()? != GROUP { session.SetGroupingParam(&GROUP, &GROUP)?; }
        Ok(())
    }

    unsafe fn refresh(
        enumerator: &IMMDeviceEnumerator,
        watches: &mut HashMap<String, EndpointWatch>,
        wake: &SyncSender<()>,
        root: u32,
        icon: &HSTRING,
    ) -> Result<()> {
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let mut live = HashSet::new();
        let owned = process_tree(root);
        for index in 0..devices.GetCount()? {
            let Ok(device) = devices.Item(index) else { continue; };
            let Some(id) = take_string(device.GetId()) else { continue; };
            live.insert(id.clone());
            if !watches.contains_key(&id) {
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue; };
                let listener: IAudioSessionNotification = SessionCreated { wake: wake.clone() }.into();
                if manager.RegisterSessionNotification(&listener).is_err() { continue; }
                watches.insert(id.clone(), EndpointWatch { manager, listener });
            }
            let watch = &watches[&id];
            let sessions = match watch.manager.GetSessionEnumerator() {
                Ok(sessions) => sessions,
                Err(_) => { watches.remove(&id); continue; }
            };
            // GetCount also enables session-created notifications on this manager.
            if let Ok(count) = sessions.GetCount() {
                for index in 0..count {
                    if let Ok(session) = sessions.GetSession(index) { let _ = brand(&session, &owned.owned, icon); }
                }
            }
        }
        watches.retain(|id, _| live.contains(id));
        Ok(())
    }

    pub(super) fn start() {
        if STARTED.swap(true, Ordering::Relaxed) { return; }
        let _ = std::thread::Builder::new().name("windows-audio-session".into()).spawn(|| unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return; }
            {
                let root = std::process::id();
                let icon = match std::env::current_exe() {
                    Ok(path) => HSTRING::from(format!("{},0", path.display())),
                    Err(_) => { CoUninitialize(); return; }
                };
                let (wake, receiver) = sync_channel(1);
                let mut watches = HashMap::new();
                loop {
                    // AudioSrv can restart. Recreate its enumerator and subscriptions.
                    let enumerator: Result<IMMDeviceEnumerator> = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
                    if let Ok(enumerator) = enumerator {
                        loop {
                            if refresh(&enumerator, &mut watches, &wake, root, &icon).is_err() { break; }
                            // Session-created callbacks wake immediately. Reconciliation also
                            // discovers newly connected output devices, without a hot poll.
                            if receiver.recv_timeout(Duration::from_secs(5)).is_ok() {
                                std::thread::sleep(Duration::from_millis(100));
                                while receiver.try_recv().is_ok() {}
                            }
                        }
                    }
                    watches.clear();
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn only_own_webview_descendants_are_grouped() {
            let candidates = [
                Process { pid: 3, parent: 2, created: 30 },
                Process { pid: 2, parent: 1, created: 20 },
                Process { pid: 6, parent: 5, created: 60 },
                Process { pid: 5, parent: 99, created: 50 },
            ];
            assert_eq!(owned_processes(1, 10, &candidates), HashSet::from([1, 2, 3]));
        }
        #[test]
        fn stale_parent_pid_cannot_relabel_another_apps_audio() {
            let candidates = [Process { pid: 2, parent: 1, created: 5 }, Process { pid: 3, parent: 2, created: 30 }];
            assert_eq!(owned_processes(1, 10, &candidates), HashSet::from([1]));
        }
    }
}

pub(crate) fn start() {
    #[cfg(windows)]
    platform::start();
}

pub(crate) fn prepare_process(identifier: &str) {
    #[cfg(windows)]
    platform::prepare_process(identifier);
    #[cfg(not(windows))]
    let _ = identifier;
}
