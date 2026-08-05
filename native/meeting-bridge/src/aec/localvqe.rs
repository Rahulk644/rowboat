//! Opt-in LocalVQE dynamic binding.
//!
//! No LocalVQE code, shared library, or GGUF model is vendored into Rowboat.
//! A packaged helper discovers two signed resources next to its own executable;
//! a debug/test build may instead use two explicit development environment
//! paths. We canonicalize both, verify the v1.4-AEC 200K GGUF SHA-256 before
//! loading, resolve only the small audited C ABI, and keep the resulting
//! context private to this processor. Library/model paths and C error text are
//! never surfaced through health or protocol events.
//!
//! LocalVQE has a 256-sample streaming hop, whereas the bridge contract is a
//! 320-sample/20 ms frame. Callers must wrap this processor in
//! [`super::StreamingReblocker`]; direct 320-sample calls are rejected.

use std::{
    ffi::CString,
    fs::{self, File},
    io::{BufReader, Read},
    os::raw::{c_char, c_int},
    path::{Path, PathBuf},
};

use libloading::Library;
use sha2::{Digest, Sha256};

use super::{AecError, AecHopProcessor, AecProcessor, StreamingReblocker};
use crate::types::AecEngine;

/// Audited upstream commit. The dynamic library selected by a host must have
/// been built from this source revision (including its pinned ggml submodule).
pub const LOCALVQE_UPSTREAM_REVISION: &str = "f53063c9eb2a85f96479867d1dd911dc3bf6319b";
/// Apache-2.0 v1.4-AEC 200K F32 GGUF used for the first qualification pass.
pub const LOCALVQE_AEC_200K_MODEL_SHA256: &str =
    "b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731";
pub const LOCALVQE_SAMPLE_RATE_HZ: i32 = 16_000;
pub const LOCALVQE_HOP_SAMPLES: usize = 256;
const LOCALVQE_LIBRARY_RESOURCE: &str = "liblocalvqe.0.1.0.dylib";
const LOCALVQE_MODEL_RESOURCE: &str = "localvqe-v1.4-aec-200K-f32.gguf";

/// Explicit host-selected, canonical local assets. This type stores paths but
/// never serializes or logs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalVqePaths {
    library: PathBuf,
    model: PathBuf,
}

impl LocalVqePaths {
    pub fn new(library: impl AsRef<Path>, model: impl AsRef<Path>) -> Result<Self, AecError> {
        let library = canonical_regular_file(library.as_ref())?;
        let model = canonical_regular_file(model.as_ref())?;
        verify_model_sha256(&model)?;
        Ok(Self { library, model })
    }

    /// Resolves explicitly supplied *development* assets. This is intentionally
    /// separate from [`Self::for_runtime`]: a release helper must never let an
    /// Electron environment variable redirect it to an arbitrary dylib/model.
    pub fn from_development_environment() -> Result<Self, AecError> {
        match (
            std::env::var_os("ROWBOAT_MEETING_AEC_LOCALVQE_LIBRARY"),
            std::env::var_os("ROWBOAT_MEETING_AEC_LOCALVQE_MODEL"),
        ) {
            (Some(library), Some(model)) => Self::new(PathBuf::from(library), PathBuf::from(model)),
            _ => Err(AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            }),
        }
    }

    /// Resolves the AEC assets used by the helper at runtime. A release build
    /// accepts only the two fixed, package-adjacent resource names. Debug and
    /// test builds retain the explicit two-variable development escape hatch
    /// so contributors can qualify a locally built model without a launcher.
    pub fn for_runtime() -> Result<Self, AecError> {
        Self::from_adjacent_packaged_resources().or_else(|_| {
            if cfg!(debug_assertions) {
                Self::from_development_environment()
            } else {
                Err(AecError::BindingUnavailable {
                    engine: AecEngine::LocalVqe,
                })
            }
        })
    }

    fn from_adjacent_packaged_resources() -> Result<Self, AecError> {
        let executable = std::env::current_exe().map_err(|_| AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        })?;
        let directory = executable.parent().ok_or(AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        })?;
        Self::new(
            directory.join(LOCALVQE_LIBRARY_RESOURCE),
            directory.join(LOCALVQE_MODEL_RESOURCE),
        )
    }

    pub fn library(&self) -> &Path {
        &self.library
    }

    pub fn model(&self) -> &Path {
        &self.model
    }
}

type LocalVqeContext = usize;
type LocalVqeNew = unsafe extern "C" fn(*const c_char) -> LocalVqeContext;
type LocalVqeFree = unsafe extern "C" fn(LocalVqeContext);
type LocalVqeProcessFrameS16 =
    unsafe extern "C" fn(LocalVqeContext, *const i16, *const i16, c_int, *mut i16) -> c_int;
type LocalVqeReset = unsafe extern "C" fn(LocalVqeContext);
type LocalVqeSampleRate = unsafe extern "C" fn(LocalVqeContext) -> c_int;
type LocalVqeHopLength = unsafe extern "C" fn(LocalVqeContext) -> c_int;

/// A loaded 256-sample LocalVQE AEC-only processor. The narrow `unsafe` FFI
/// island is intentionally isolated in this feature-gated module; all public
/// callers work only with owned Rust PCM slices and typed errors.
#[allow(unsafe_code, reason = "audited opt-in LocalVQE C ABI boundary")]
pub struct LocalVqeHopProcessor {
    // The library must outlive all function pointers and the C context.
    _library: Library,
    context: LocalVqeContext,
    free: LocalVqeFree,
    process_frame_s16: LocalVqeProcessFrameS16,
    reset: LocalVqeReset,
}

#[allow(unsafe_code, reason = "audited opt-in LocalVQE C ABI boundary")]
impl LocalVqeHopProcessor {
    pub fn load(paths: LocalVqePaths) -> Result<Self, AecError> {
        let model = CString::new(paths.model.as_os_str().as_encoded_bytes()).map_err(|_| {
            AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            }
        })?;
        // `Library::new` and symbol resolution are the only dynamic loading
        // operations. The path was canonicalized as a regular file above.
        let library =
            unsafe { Library::new(&paths.library) }.map_err(|_| AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            })?;
        let new = unsafe { symbol::<LocalVqeNew>(&library, b"localvqe_new\0")? };
        let free = unsafe { symbol::<LocalVqeFree>(&library, b"localvqe_free\0")? };
        let process_frame_s16 = unsafe {
            symbol::<LocalVqeProcessFrameS16>(&library, b"localvqe_process_frame_s16\0")?
        };
        let reset = unsafe { symbol::<LocalVqeReset>(&library, b"localvqe_reset\0")? };
        let sample_rate =
            unsafe { symbol::<LocalVqeSampleRate>(&library, b"localvqe_sample_rate\0")? };
        let hop_length =
            unsafe { symbol::<LocalVqeHopLength>(&library, b"localvqe_hop_length\0")? };
        let context = unsafe { new(model.as_ptr()) };
        if context == 0 {
            return Err(AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            });
        }
        let processor = Self {
            _library: library,
            context,
            free,
            process_frame_s16,
            reset,
        };
        let valid_format = unsafe {
            sample_rate(processor.context) == LOCALVQE_SAMPLE_RATE_HZ
                && hop_length(processor.context) == LOCALVQE_HOP_SAMPLES as c_int
        };
        if valid_format {
            Ok(processor)
        } else {
            // Drop frees the context before the library unloads.
            drop(processor);
            Err(AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            })
        }
    }
}

/// Loads the package-adjacent LocalVQE assets (or explicit debug/test assets)
/// and wraps its 256-sample C API in the bridge's ordered, bounded 320↔256
/// reblocker. The returned processor can be passed directly to
/// [`super::AecCoordinator::with_processor`].
pub fn build_aec_processor() -> Result<Box<dyn AecProcessor>, AecError> {
    let paths = LocalVqePaths::for_runtime()?;
    let processor = LocalVqeHopProcessor::load(paths)?;
    Ok(Box::new(StreamingReblocker::new(processor)))
}

#[allow(unsafe_code, reason = "audited opt-in LocalVQE C ABI boundary")]
impl Drop for LocalVqeHopProcessor {
    fn drop(&mut self) {
        if self.context != 0 {
            unsafe { (self.free)(self.context) };
            self.context = 0;
        }
    }
}

#[allow(unsafe_code, reason = "audited opt-in LocalVQE C ABI boundary")]
impl AecHopProcessor for LocalVqeHopProcessor {
    fn engine(&self) -> AecEngine {
        AecEngine::LocalVqe
    }

    fn hop_samples(&self) -> usize {
        LOCALVQE_HOP_SAMPLES
    }

    fn process_hop(
        &mut self,
        render_pcm_s16le: &[i16],
        mic_pcm_s16le: &[i16],
    ) -> Result<Vec<i16>, AecError> {
        if render_pcm_s16le.len() != LOCALVQE_HOP_SAMPLES
            || mic_pcm_s16le.len() != LOCALVQE_HOP_SAMPLES
        {
            return Err(AecError::InvalidFrame);
        }
        let mut output = vec![0_i16; LOCALVQE_HOP_SAMPLES];
        let result = unsafe {
            (self.process_frame_s16)(
                self.context,
                mic_pcm_s16le.as_ptr(),
                render_pcm_s16le.as_ptr(),
                LOCALVQE_HOP_SAMPLES as c_int,
                output.as_mut_ptr(),
            )
        };
        (result == 0)
            .then_some(output)
            .ok_or_else(|| AecError::Processor {
                engine: AecEngine::LocalVqe,
                message: "LocalVQE processing failed".into(),
            })
    }

    fn reset(&mut self) {
        unsafe { (self.reset)(self.context) };
    }
}

#[allow(unsafe_code, reason = "audited opt-in LocalVQE C ABI boundary")]
unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, AecError> {
    library
        .get::<T>(name)
        .map(|symbol| *symbol)
        .map_err(|_| AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        })
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, AecError> {
    let canonical = fs::canonicalize(path).map_err(|_| AecError::BindingUnavailable {
        engine: AecEngine::LocalVqe,
    })?;
    let is_regular = fs::metadata(&canonical)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    (canonical.is_absolute() && is_regular)
        .then_some(canonical)
        .ok_or(AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        })
}

fn verify_model_sha256(model: &Path) -> Result<(), AecError> {
    let file = File::open(model).map_err(|_| AecError::BindingUnavailable {
        engine: AecEngine::LocalVqe,
    })?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| AecError::BindingUnavailable {
                engine: AecEngine::LocalVqe,
            })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    (actual == LOCALVQE_AEC_200K_MODEL_SHA256)
        .then_some(())
        .ok_or(AecError::BindingUnavailable {
            engine: AecEngine::LocalVqe,
        })
}

#[cfg(test)]
mod tests {
    use super::{LocalVqeHopProcessor, LocalVqePaths, LOCALVQE_HOP_SAMPLES};
    use crate::aec::AecHopProcessor;

    #[test]
    fn optional_smoke_uses_only_explicit_verified_assets() {
        let Ok(paths) = LocalVqePaths::from_development_environment() else {
            return;
        };
        let mut processor =
            LocalVqeHopProcessor::load(paths).expect("verified LocalVQE assets load");
        let output = processor
            .process_hop(
                &vec![0; LOCALVQE_HOP_SAMPLES],
                &vec![0; LOCALVQE_HOP_SAMPLES],
            )
            .expect("one silent LocalVQE hop");
        assert_eq!(output.len(), LOCALVQE_HOP_SAMPLES);
    }
}
