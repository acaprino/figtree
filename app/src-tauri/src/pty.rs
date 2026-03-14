use std::collections::BTreeMap;
use std::io;
use std::mem::{size_of, zeroed};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::*;
use windows::Win32::System::Pipes::*;
use windows::Win32::System::Threading::*;

/// Represents a running pseudo-console session.
pub struct PtySession {
    pub hpc: HPCON,
    pub process_handle: HANDLE,
    pub thread_handle: HANDLE,
    /// Guarded by a Mutex for per-session write serialization, so that concurrent
    /// callers (e.g. Tauri IPC thread + any future writer) do not race on WriteFile.
    pub input_write: Mutex<HANDLE>,
    pub output_read: HANDLE,
    #[allow(dead_code)]
    pub pid: u32,
    /// Guards against double-close of the pseudo console handle.
    /// `kill()` closes it to break the pipe, and `Drop` must skip it if already closed.
    console_closed: AtomicBool,
    _attr_list_buf: Vec<u8>,
}

// SAFETY: PtySession holds raw Windows HANDLEs which are `!Send` by default.
// This is safe because:
// - input_write is protected by a Mutex, ensuring serialized access from any thread.
// - output_read is only used by the dedicated reader thread via read().
// - process_handle and thread_handle are only used for wait/terminate operations
//   which are thread-safe Win32 calls.
// - hpc (pseudo console handle) is used for resize from the main thread and
//   closed via kill() or Drop (guarded by console_closed AtomicBool);
//   ClosePseudoConsole is safe to call from any thread.
unsafe impl Send for PtySession {}
unsafe impl Sync for PtySession {}

fn create_pipe() -> io::Result<(HANDLE, HANDLE)> {
    let mut read_handle = HANDLE::default();
    let mut write_handle = HANDLE::default();
    unsafe {
        CreatePipe(&mut read_handle, &mut write_handle, None, 0)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    }
    Ok((read_handle, write_handle))
}

/// Helper to close a HANDLE if it is not null/invalid.
fn close_handle_safe(h: HANDLE) {
    if !h.is_invalid() && h != HANDLE::default() {
        unsafe {
            let _ = CloseHandle(h);
        }
    }
}

impl PtySession {
    /// Spawn a new process in a pseudo console.
    pub fn spawn(
        command: &str,
        working_dir: &str,
        env: &[(String, String)],
        cols: i16,
        rows: i16,
    ) -> io::Result<Self> {
        log_debug!("pty: creating pseudo console {cols}x{rows} for: {}", &command[..command.len().min(120)]);
        let (pty_input_read, pty_input_write) = create_pipe()?;
        let (pty_output_read, pty_output_write) = match create_pipe() {
            Ok(handles) => handles,
            Err(e) => {
                // Clean up the first pipe pair on failure
                close_handle_safe(pty_input_read);
                close_handle_safe(pty_input_write);
                return Err(e);
            }
        };

        let size = COORD { X: cols, Y: rows };
        let hpc = match unsafe {
            CreatePseudoConsole(size, pty_input_read, pty_output_write, 0)
        } {
            Ok(hpc) => {
                // These ends are now owned by the pseudo console
                unsafe {
                    let _ = CloseHandle(pty_input_read);
                    let _ = CloseHandle(pty_output_write);
                }
                hpc
            }
            Err(e) => {
                // Clean up all four pipe handles on failure
                close_handle_safe(pty_input_read);
                close_handle_safe(pty_input_write);
                close_handle_safe(pty_output_read);
                close_handle_safe(pty_output_write);
                return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
            }
        };

        let mut attr_list_size: usize = 0;
        // First call to get required size -- expected to fail
        let _ = unsafe {
            InitializeProcThreadAttributeList(
                None,
                1,
                Some(0),
                &mut attr_list_size,
            )
        };

        let mut attr_list_buf: Vec<u8> = vec![0u8; attr_list_size];
        let attr_list =
            LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buf.as_mut_ptr() as *mut _);

        if let Err(e) = unsafe {
            InitializeProcThreadAttributeList(Some(attr_list), 1, Some(0), &mut attr_list_size)
        } {
            unsafe { ClosePseudoConsole(hpc); }
            close_handle_safe(pty_input_write);
            close_handle_safe(pty_output_read);
            return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
        }

        if let Err(e) = unsafe {
            UpdateProcThreadAttribute(
                attr_list,
                0,
                0x00020016, // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
                Some(hpc.0 as *const _),
                size_of::<HPCON>(),
                None,
                None,
            )
        } {
            unsafe {
                DeleteProcThreadAttributeList(attr_list);
                ClosePseudoConsole(hpc);
            }
            close_handle_safe(pty_input_write);
            close_handle_safe(pty_output_read);
            return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
        }

        let mut si: STARTUPINFOEXW = unsafe { zeroed() };
        si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;

        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };

        // Build environment block using BTreeMap to deduplicate keys.
        // Inherited env is inserted first, then custom values overwrite.
        let mut env_map: BTreeMap<String, String> = std::env::vars().collect();
        for (k, v) in env {
            env_map.insert(k.clone(), v.clone());
        }
        let mut env_block: Vec<String> = env_map
            .into_iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        env_block.push(String::new());
        let env_str = env_block.join("\0");
        let env_wide: Vec<u16> = env_str.encode_utf16().chain(std::iter::once(0)).collect();

        let mut cmd_wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();

        let work_dir_wide: Vec<u16> =
            working_dir.encode_utf16().chain(std::iter::once(0)).collect();

        if let Err(e) = unsafe {
            CreateProcessW(
                None,
                Some(PWSTR(cmd_wide.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                Some(env_wide.as_ptr() as *const _),
                PCWSTR(work_dir_wide.as_ptr()),
                &si.StartupInfo as *const STARTUPINFOW,
                &mut pi,
            )
        } {
            unsafe {
                DeleteProcThreadAttributeList(attr_list);
                ClosePseudoConsole(hpc);
            }
            close_handle_safe(pty_input_write);
            close_handle_safe(pty_output_read);
            return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
        }

        let pid = pi.dwProcessId;
        log_info!("pty: spawned pid={pid}, console={cols}x{rows}");

        Ok(PtySession {
            hpc,
            process_handle: pi.hProcess,
            thread_handle: pi.hThread,
            input_write: Mutex::new(pty_input_write),
            output_read: pty_output_read,
            pid,
            console_closed: AtomicBool::new(false),
            _attr_list_buf: attr_list_buf,
        })
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        let handle = *self.input_write.lock().unwrap_or_else(|e| e.into_inner());
        let mut offset = 0;
        while offset < data.len() {
            let mut written: u32 = 0;
            unsafe {
                WriteFile(handle, Some(&data[offset..]), Some(&mut written), None)
                    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
            }
            if written == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "WriteFile wrote 0 bytes"));
            }
            offset += written as usize;
        }
        Ok(())
    }

    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut bytes_read: u32 = 0;
        unsafe {
            ReadFile(self.output_read, Some(buf), Some(&mut bytes_read), None)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }
        Ok(bytes_read as usize)
    }

    pub fn resize(&self, cols: i16, rows: i16) -> io::Result<()> {
        if self.console_closed.load(Ordering::SeqCst) {
            log_warn!("pty: resize attempted on closed console pid={}", self.pid);
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "Console already closed"));
        }
        log_debug!("pty: resize pid={} to {cols}x{rows}", self.pid);
        unsafe {
            ResizePseudoConsole(self.hpc, COORD { X: cols, Y: rows })
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }
        Ok(())
    }

    pub fn wait_for_exit(&self) -> io::Result<i32> {
        unsafe {
            let result = WaitForSingleObject(self.process_handle, INFINITE);
            if result == WAIT_FAILED {
                return Err(io::Error::last_os_error());
            }
            let mut exit_code: u32 = 0;
            GetExitCodeProcess(self.process_handle, &mut exit_code)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
            Ok(exit_code as i32)
        }
    }

    /// Terminate the child process and close the pseudo console handle.
    /// Closing the pseudo console breaks the output pipe, which unblocks
    /// any reader thread blocked on ReadFile.
    pub fn kill(&self) {
        log_info!("pty: killing pid={}", self.pid);
        unsafe {
            let _ = TerminateProcess(self.process_handle, 1);
            if !self.console_closed.swap(true, Ordering::SeqCst) {
                ClosePseudoConsole(self.hpc);
            }
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        log_debug!("pty: dropping session pid={}", self.pid);
        unsafe {
            // Delete the proc thread attribute list before the buffer is freed
            // to avoid leaking internal Windows allocations.
            DeleteProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(self._attr_list_buf.as_mut_ptr() as *mut _),
            );
            // Only close the pseudo console if kill() hasn't already done so.
            // Double-closing an HPCON is NOT safe — it causes heap corruption
            // because the handle's internal memory is freed on the first close.
            if !self.console_closed.swap(true, Ordering::SeqCst) {
                ClosePseudoConsole(self.hpc);
            }
            let _ = CloseHandle(self.process_handle);
            let _ = CloseHandle(self.thread_handle);
            let handle = *self.input_write.lock().unwrap_or_else(|e| e.into_inner());
            let _ = CloseHandle(handle);
            let _ = CloseHandle(self.output_read);
        }
    }
}
