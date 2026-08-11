//! JNI adapter for the RDS decoder — the first thing to call the portable core.
//!
//! ## What this is for
//!
//! The core has had no caller. It is proven equal to the TypeScript over a
//! generated corpus, but nothing has ever run it on the hardware, and no line of
//! TypeScript has been deleted because of it. This crate is the seam that
//! changes that, and it is deliberately the smallest one that can: hand it a
//! group, get back the same one-line state string the differential harness
//! prints.
//!
//! That shared format is the point. `carfm_rds::format_state` renders both this
//! and `examples/rds-dump.rs`, so a capture taken on the device can be diffed
//! against the TypeScript decoder's output for the same groups with no
//! conversion — the differential, run against real air instead of a corpus.
//!
//! ## Lifetime and threading
//!
//! `rdsNew` leaks a boxed decoder and returns its address; `rdsFree` takes it
//! back. The handle is opaque to Kotlin and must not be shared between threads —
//! the RDS pump is a single thread and owns it. Every entry point tolerates a
//! zero handle so a Kotlin-side mistake is a no-op rather than a crash in a car.
//!
//! ## The second parameter is not really a class
//!
//! The Kotlin side is an `object`, so these compile to INSTANCE methods on the
//! singleton and JNI passes the instance where the signatures below say
//! `JClass`. Both are a bare pointer at the ABI, and nothing here reads it, so
//! the mismatch is harmless — but it is a mismatch, and worth knowing before
//! someone "fixes" the Kotlin to a class with static methods and wonders why
//! nothing changed. The symbol names are what actually bind: they must stay
//! `Java_<package with underscores>_CarfmCore_<method>`, or the failure is an
//! UnsatisfiedLinkError at the first call, on the device, in a car.
use carfm_rds::{format_state, RdsDecoder};
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

/// Borrow the decoder behind a handle, or do nothing if it is null.
///
/// Unsafe by nature — the pointer came from Kotlin. The zero check is what makes
/// the common mistake (calling after free, or before new) survivable.
unsafe fn with<T>(handle: jlong, f: impl FnOnce(&mut RdsDecoder) -> T) -> Option<T> {
    if handle == 0 {
        return None;
    }
    Some(f(&mut *(handle as *mut RdsDecoder)))
}

#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsNew(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    Box::into_raw(Box::new(RdsDecoder::new())) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsFree(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        // Reclaim the box leaked by rdsNew.
        unsafe { drop(Box::from_raw(handle as *mut RdsDecoder)) };
    }
}

/// Feed one group. Returns the state line when a user-visible field changed, and
/// null when nothing did — mirroring `RdsDecoder::push`, so the caller can log
/// only the changes exactly as the app does.
#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsPush<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
    hex: JString<'a>,
) -> jstring {
    let Ok(hex) = env.get_string(&hex) else {
        return std::ptr::null_mut();
    };
    let hex: String = hex.into();
    let changed = unsafe { with(handle, |d| d.push(&hex).is_some()) }.unwrap_or(false);
    if !changed {
        return std::ptr::null_mut();
    }
    state_string(&mut env, handle)
}

/// The current state line regardless of whether anything changed — for the
/// carrier-returned-after-an-expiry path, which the app already handles.
#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsState<'a>(
    mut env: JNIEnv<'a>,
    _class: JClass<'a>,
    handle: jlong,
) -> jstring {
    state_string(&mut env, handle)
}

#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsReset(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    unsafe { with(handle, |d| d.reset()) };
}

#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsResetForRetune(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    unsafe { with(handle, |d| d.reset_for_retune()) };
}

#[no_mangle]
pub extern "system" fn Java_com_ninthfreak_carfm_CarfmCore_rdsClearTa(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    unsafe { with(handle, |d| d.clear_ta()) };
}

fn state_string(env: &mut JNIEnv, handle: jlong) -> jstring {
    let Some(line) = (unsafe {
        with(handle, |d| {
            format_state(&d.state(), &d.stats(), &d.quality())
        })
    }) else {
        return std::ptr::null_mut();
    };
    env.new_string(line)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
