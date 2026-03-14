use std::collections::BTreeMap;
use std::io;
use std::mem::{size_of, zeroed};

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
    pub input_write: HANDLE,
    pub output_read: HANDLE,
    pub pid: u32,
    _attr_list_buf: Vec<u8>,
}

// SAFETY: PtySession holds raw Windows HANDLEs which are `!Send` by default.
// This is safe because:
// - The Windows pipe handles (input_write, output_read) are used from separate
//   threads but never concurrently on the same handle: input_write is only used
//   by the main thread via write(), and output_read is only used by the dedicated
//   reader thread via read().
// - process_handle and thread_handle are only used for wait/terminate operations
//   which are thread-safe Win32 calls.
// - hpc (pseudo console handle) is used for resize from the main thread and
//   closed in Drop; ClosePseudoConsole is safe to call from any thread.
// - The architecture guarantees single-writer access to input_write (frontend
//   sends write_pty calls sequentially through Tauri IPC).
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

impl PtySession {
    /// Spawn a new process in a pseudo console.
    pub fn spawn(
        command: &str,
        working_dir: &str,
        env: &[(String, String)],
        cols: i16,
        rows: i16,
    ) -> io::Result<Self> {
        let (pty_input_read, pty_input_write) = create_pipe()?;
        let (pty_output_read, pty_output_write) = create_pipe()?;

        let size = COORD { X: cols, Y: rows };
        let hpc = unsafe {
            CreatePseudoConsole(size, pty_input_read, pty_output_write, 0)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?
        };

        unsafe {
            let _ = CloseHandle(pty_input_read);
            let _ = CloseHandle(pty_output_write);
        }

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

        unsafe {
            InitializeProcThreadAttributeList(Some(attr_list), 1, Some(0), &mut attr_list_size)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

            UpdateProcThreadAttribute(
                attr_list,
                0,
                0x00020016, // PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
                Some(hpc.0 as *const _),
                size_of::<HPCON>(),
                None,
                None,
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
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

        unsafe {
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
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }

        Ok(PtySession {
            hpc,
            process_handle: pi.hProcess,
            thread_handle: pi.hThread,
            input_write: pty_input_write,
            output_read: pty_output_read,
            pid: pi.dwProcessId,
            _attr_list_buf: attr_list_buf,
        })
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        let mut offset = 0;
        while offset < data.len() {
            let mut written: u32 = 0;
            unsafe {
                WriteFile(self.input_write, Some(&data[offset..]), Some(&mut written), None)
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

    pub fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.process_handle, 1);
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        unsafe {
            // Delete the proc thread attribute list before the buffer is freed
            // to avoid leaking internal Windows allocations.
            DeleteProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(self._attr_list_buf.as_mut_ptr() as *mut _),
            );
            ClosePseudoConsole(self.hpc);
            let _ = CloseHandle(self.process_handle);
            let _ = CloseHandle(self.thread_handle);
            let _ = CloseHandle(self.input_write);
            let _ = CloseHandle(self.output_read);
        }
    }
}
