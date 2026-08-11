# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# ── Vendor AIDL — insurance on a configuration that has never run ────────────
#
# NOTHING IN THIS FILE HAS EVER BEEN EXERCISED. `minifyEnabled` resolves from
# `android.enableMinifyInReleaseBuilds`, which defaults false and is set nowhere,
# so R8 has never processed this app — in debug OR release. The moment someone
# turns it on, most likely while shrinking an APK for distribution, these are the
# classes with the most to lose: `com.nwd.radio.service.*` is the reconstructed
# vendor AIDL (src/main/aidl) plus two hand-written parcelables, compiled INTO
# the app, and the whole tuner reaches the head unit's radio service through it.
#
# Stated honestly: this is insurance, not a fix for an observed break. R8's
# defaults may well preserve everything the binder needs — the AIDL DESCRIPTOR is
# a string constant, and Parcelable CREATOR fields have a default keep rule. But
# "probably fine" is a bad thing to be discovering about the tuner in a release
# build, on a head unit with no debugger attached, in a car.
#
# Checked and deliberately NOT kept here: `com.nwd.app.NwdFmManager` is a ROM
# framework class reached via Class.forName, so it is not in the APK and R8
# cannot rename it; the getter names reflected on it are string literals, which
# R8 does not touch either.
-keep class com.nwd.** { *; }

# Add any project specific keep options here:
