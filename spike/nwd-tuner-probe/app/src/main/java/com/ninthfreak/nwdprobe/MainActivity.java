package com.ninthfreak.nwdprobe;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.database.ContentObserver;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Parcel;
import android.os.RemoteException;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.method.ScrollingMovementMethod;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.nwd.radio.service.RadioCallback;
import com.nwd.radio.service.RadioFeature;
import com.nwd.radio.service.data.Frequency;
import com.nwd.radio.service.data.RadioPoint;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;

/**
 * NWD built-in FM tuner — STANDALONE-AUDIO probe (heavily instrumented).
 *
 * ONE question: can FM audio be brought up WITHOUT launching the stock radio app?
 *
 * From decompiling com.nwd.radio.service (Spreadtrum path):
 *   SprdRadioManager$1.onReceive — no permission / no caller check — on:
 *     • com.nwd.action.ACTION_APP_IN_OUT   extra_app_id(int) ==8 -> SprdFMFeature.InitFM()
 *     • com.nwd.ACTION_MEDIA_PLAY          extra_app_id(int) ==8 -> InitFM() (else ExitFm)
 *     • com.nwd.action.ACTION_CHANGE_SOURCE extra_source_id(byte)==4 -> FM (else ExitFm)
 *     • com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO -> ExitFm()
 *   InitFM (guards: skip if already POWER_UP / BT call / power-downing) ->
 *     openDevice + powerUpFm -> powerUp: requestAudioFocus -> native powerUp ->
 *     updateRdsEnableState (RDS on) + enableFmAudio + setForceUse(speaker) + unmute@+1800ms.
 *   setCurrentFrequency ignores a tune to the freq it's already on (freq!=cur guard);
 *     tuneStation from POWER_DOWN runs powerUp+playFrequency (audio).
 * (Writing mcu_current_source directly is a DEAD END — system perm + MCU re-asserts.)
 *
 * RUN AUDIO TEST climbs a ladder, stopping at the first rung that makes sound, and
 * asks ONE yes/no per rung via inline buttons. Around every rung it captures a lot
 * of machine data so a "No" is still diagnosable:
 *   - the service's OWN logcat trail (InitFM / powerUp = / requestAudioFocus / setForceUse …)
 *   - a per-second time-series of tuner + audio state through the wait
 *   - AudioManager snapshot (music active / volume / route)
 *   - a full baseline dump + hidden-parcel-field hunt + getprop + was-service-already-running
 *   - an end-of-run summary table
 * Everything lands in one log saved to Downloads.
 *
 * Throwaway RE harness, NOT the CarFM backend. AIDL is a clean-room reconstruction.
 */
public class MainActivity extends Activity {

    private static final String SERVICE_PKG = "com.nwd.radio.service";
    private static final String SERVICE_CLS = "com.nwd.radio.service.RadioService";
    private static final String BIND_ACTION = "com.nwd.radio.service.ACTION_RADIO_SERVICE";
    private static final String SRC_KEY = "mcu_current_source";
    private static final double STRONG_MHZ = 101.5;   // user reports this comes in best
    private static final String RF_DESCRIPTOR = "com.nwd.radio.service.RadioFeature";
    // getCurrentFrequency is AIDL method #2 -> FIRST_CALL_TRANSACTION + 1 (for the raw dump).
    private static final int TXN_GET_CURRENT_FREQ = IBinder.FIRST_CALL_TRANSACTION + 1;

    private volatile RadioFeature radio;   // set on main thread, read from the worker
    private AudioManager am;
    private TextView log;
    private EditText mhzField, bandField;
    private int freqMult = 1000;
    private byte fmBand = 0;
    private MediaPlayer vendorMp;
    private volatile double uiMhz = STRONG_MHZ;   // target latched from the MHz box (UI thread)

    private LinearLayout promptPanel;
    private TextView promptText;
    private LinearLayout promptButtons;

    private final StringBuilder logBuf = new StringBuilder();
    private final StringBuilder summary = new StringBuilder();
    private final ArrayBlockingQueue<String> answer = new ArrayBlockingQueue<>(1);
    private volatile boolean testRunning = false;
    private volatile boolean logcatReadable = false;
    private volatile boolean preConnected = false;
    private ContentObserver sourceObserver;
    private BroadcastReceiver nwdRx;

    // ── UI ────────────────────────────────────────────────────────────────────
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        am = (AudioManager) getSystemService(AUDIO_SERVICE);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(10);
        root.setPadding(pad, pad, pad, pad);

        Button full = btn("▶  RUN AUDIO TEST (standalone bring-up)", v -> runAudioTest());
        full.setTextSize(16f);
        root.addView(full);

        Button rf = btn("▶  RUN RADIO FUNCTIONS (tune · seek · RDS)", v -> runRadioFunc());
        rf.setTextSize(15f);
        root.addView(rf);

        Button wp = btn("▶  OVERWRITE BUILT-IN PRESETS (app → unit)", v -> runWritePresets());
        wp.setTextSize(15f);
        root.addView(wp);

        promptPanel = new LinearLayout(this);
        promptPanel.setOrientation(LinearLayout.VERTICAL);
        promptPanel.setBackgroundColor(0xFF203040);
        int pp = dp(12);
        promptPanel.setPadding(pp, pp, pp, pp);
        promptText = new TextView(this);
        promptText.setTextSize(16f);
        promptText.setTextColor(Color.WHITE);
        promptButtons = new LinearLayout(this);
        promptButtons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams btnRowLp = new LinearLayout.LayoutParams(-1, -2);
        btnRowLp.topMargin = dp(8);
        promptButtons.setLayoutParams(btnRowLp);
        promptPanel.addView(promptText);
        promptPanel.addView(promptButtons);
        promptPanel.setVisibility(View.GONE);
        root.addView(promptPanel);

        root.addView(btn("Connect (bind service)", v -> wakeAndBind()));

        LinearLayout tuneRow = new LinearLayout(this);
        tuneRow.setOrientation(LinearLayout.HORIZONTAL);
        mhzField = new EditText(this); mhzField.setText(String.valueOf(STRONG_MHZ));
        mhzField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 2f));
        bandField = new EditText(this); bandField.setText("0");
        bandField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        tuneRow.addView(label("MHz")); tuneRow.addView(mhzField);
        tuneRow.addView(label("band")); tuneRow.addView(bandField);
        root.addView(tuneRow);

        LinearLayout manual = new LinearLayout(this);
        manual.setOrientation(LinearLayout.HORIZONTAL);
        manual.addView(weighted(btn("Tune", v -> tuneMhz())));
        manual.addView(weighted(btn("Dump banks", v -> new Thread(this::dumpAllBanks).start())));
        manual.addView(weighted(btn("Rich dump", v -> new Thread(() -> richDump("manual")).start())));
        manual.addView(weighted(btn("logcat", v -> new Thread(() -> captureLogcat("manual")).start())));
        manual.addView(weighted(btn("Save log", v -> saveLog())));
        root.addView(manual);

        LinearLayout bcRow = new LinearLayout(this);
        bcRow.setOrientation(LinearLayout.HORIZONTAL);
        bcRow.addView(weighted(btn("APP_IN_OUT 8", v -> sendAppInOut(8))));
        bcRow.addView(weighted(btn("MEDIA_PLAY 8", v -> sendMediaPlay(8))));
        bcRow.addView(weighted(btn("REQ SRC 4", v -> sendRequestSource((byte) 4))));
        bcRow.addView(weighted(btn("EXIT FM", v -> sendExitFm())));
        root.addView(bcRow);

        log = new TextView(this);
        log.setTextSize(11f);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setTypeface(Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(log);
        root.addView(sv);

        setContentView(root);
        line("Ready. Volume UP, nothing else playing, stock radio app CLOSED, then tap RUN AUDIO TEST.");
    }

    // ── Service wake + binding ─────────────────────────────────────────────────
    private void wakeAndBind() {
        Intent i = new Intent(BIND_ACTION).setComponent(new ComponentName(SERVICE_PKG, SERVICE_CLS));
        try { startService(i); } catch (Exception e) { line("startService threw " + e); }
        try {
            boolean ok = bindService(new Intent(BIND_ACTION).setPackage(SERVICE_PKG), conn, Context.BIND_AUTO_CREATE);
            line("bindService=" + ok + (ok ? "" : "  <-- FALSE = not bindable (service may still be running for broadcasts)"));
        } catch (Exception e) { line("bindService threw " + e); }
    }

    /** Was the radio service ALREADY running before we touched it? Bind with NO
     *  auto-create: it only connects if the process is already up. Distinguishes
     *  "resident from boot" (broadcasts land) from "we had to create it". */
    private boolean preflightAlreadyRunning() {
        preConnected = false;
        boolean ok = false;
        try { ok = bindService(new Intent(BIND_ACTION).setPackage(SERVICE_PKG), preConn, 0); }
        catch (Exception e) { line("preflight bind threw " + e); }
        for (int i = 0; !preConnected && i < 6; i++) sleep(300);   // ~1.8s
        boolean running = preConnected;
        try { if (ok) unbindService(preConn); } catch (Exception ignored) {}
        line("preflight: service already running = " + running + " (noCreate bind=" + ok + ")");
        return running;
    }

    private final ServiceConnection preConn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName n, IBinder b) { preConnected = true; }
        @Override public void onServiceDisconnected(ComponentName n) {}
    };

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            radio = RadioFeature.Stub.asInterface(binder);
            line("CONNECTED to " + name.flattenToShortString());
            try { radio.registCallback(callback); line("registCallback OK"); }
            catch (RemoteException e) { line("registCallback FAILED: " + e); }
            startSourceObserver();
            startBroadcastLogger();
            calibrate();
        }
        @Override public void onServiceDisconnected(ComponentName name) { radio = null; line("DISCONNECTED"); }
    };

    // ── The audio bring-up ladder ──────────────────────────────────────────────
    private void runAudioTest() {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(this::audioTestBody, "nwd-audiotest").start();
    }

    private void audioTestBody() {
        line("\n==== STANDALONE AUDIO BRING-UP TEST ====");
        prompt("This tests whether FM audio can start WITHOUT the stock radio app.\n\n"
             + "• Turn the volume UP.\n"
             + "• Make sure NOTHING else is playing (Bluetooth, music apps).\n"
             + "• Do NOT open the stock radio app.\n\n"
             + "Tap Start.", "Start");

        boolean wasRunning = preflightAlreadyRunning();
        wakeAndBind();
        for (int i = 0; radio == null && i < 16; i++) sleep(500);
        line("service bound = " + (radio != null) + "; was already running = " + wasRunning);

        richDump("baseline");
        getpropDump();
        int origSrc = readSource();
        sendStopQqMusic(); sleep(600); audioSnap("after STOP_QQ_MUSIC");

        String worked = null;

        // RUNG 1 — the stock app's own FM audio trigger.
        {
            String before = stateLine();
            line("\n-- RUNG 1: ACTION_APP_IN_OUT extra_app_id=8  →  service InitFM() --");
            sendAppInOut(8);
            watch("RUNG1", 5000, 1000);      // captures mute(t0) → unmute(~1.8s) → powerUp
            captureLogcat("RUNG1"); audioSnap("after RUNG1");
            boolean y = audioYes("RUNG 1");
            rungLog("RUNG 1 — ACTION_APP_IN_OUT app_id=8", before, stateLine(), y);
            if (y) worked = "RUNG 1 — ACTION_APP_IN_OUT app_id=8";
        }

        // RUNG 2 — same InitFM via the other action.
        if (worked == null) {
            String before = stateLine();
            line("\n-- RUNG 2: ACTION_MEDIA_PLAY extra_app_id=8  →  service InitFM() --");
            sendMediaPlay(8);
            watch("RUNG2", 5000, 1000);
            captureLogcat("RUNG2"); audioSnap("after RUNG2");
            boolean y = audioYes("RUNG 2");
            rungLog("RUNG 2 — ACTION_MEDIA_PLAY app_id=8", before, stateLine(), y);
            if (y) worked = "RUNG 2 — ACTION_MEDIA_PLAY app_id=8";
        }

        // RUNG 3 — tune via AIDL (Sprd tuneStation → powerUp). setCurrentFrequency
        // ignores a tune to the current freq, so nudge off-target first if needed.
        if (worked == null) {
            String before = stateLine();
            line("\n-- RUNG 3: setCurrentFrequency (Sprd tune→powerUp) --");
            if (radio == null) line("  (not bound — skipping)");
            else {
                double cur = currentMhz();
                if (cur > 0 && Math.abs(cur - STRONG_MHZ) < 0.05) {
                    line("  already on " + STRONG_MHZ + "; nudging to " + (STRONG_MHZ - 0.2) + " first so the tune isn't ignored");
                    tuneMhzTo(STRONG_MHZ - 0.2); sleep(2000);
                }
                tuneMhzTo(STRONG_MHZ);
                watch("RUNG3", 5000, 1000);
                captureLogcat("RUNG3"); audioSnap("after RUNG3");
            }
            boolean y = radio != null && audioYes("RUNG 3");
            rungLog("RUNG 3 — setCurrentFrequency powerUp", before, stateLine(), y);
            if (y) worked = "RUNG 3 — setCurrentFrequency powerUp";
        }

        // RUNG 4 — ask the MCU to physically switch the head-unit source to FM.
        if (worked == null) {
            line("\n-- RUNG 4: ACTION_REQUEST_CHANGE_SOURCE (physical source switch) --");
            prompt("RUNG 4 will ask the head unit to switch its WHOLE audio source to Radio "
                 + "— like pressing 'Radio' on the unit. Tap OK to send.", "OK");
            String before = stateLine();
            sendRequestSource((byte) 4);
            watch("RUNG4a", 5000, 1000); captureLogcat("RUNG4a"); audioSnap("after RUNG4 src=4");
            boolean y = audioYes("RUNG 4 (source→4)");
            if (!y) {
                line("  retrying with extra_source_id=8…");
                sendRequestSource((byte) 8);
                watch("RUNG4b", 5000, 1000); captureLogcat("RUNG4b"); audioSnap("after RUNG4 src=8");
                y = audioYes("RUNG 4 (source→8)");
            }
            rungLog("RUNG 4 — ACTION_REQUEST_CHANGE_SOURCE", before, stateLine(), y);
            if (y) worked = "RUNG 4 — ACTION_REQUEST_CHANGE_SOURCE";
        }

        // RUNG 5 — public-API long shot (vendor FM URI through MediaPlayer).
        if (worked == null) {
            String before = stateLine();
            line("\n-- RUNG 5: MediaPlayer THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM (long shot) --");
            tryVendorMediaPlayer();
            watch("RUNG5", 4000, 1000); captureLogcat("RUNG5"); audioSnap("after RUNG5");
            boolean y = audioYes("RUNG 5");
            rungLog("RUNG 5 — vendor MediaPlayer URI", before, stateLine(), y);
            if (y) worked = "RUNG 5 — vendor MediaPlayer URI";
        }

        line("\n==== RESULT: " + (worked != null ? "AUDIO via " + worked : "NO rung produced audio") + " ====");
        // Full final dump — the raw parcel here runs while FM is LIVE, so hidden
        // per-station fields (RSSI/stereo/lock) would be populated if they exist.
        richDump("final");

        String c = prompt("Test done. Turn the tuner audio back off?", "Stop FM", "Leave it playing");
        if ("Stop FM".equals(c)) {
            sendExitFm();
            if (origSrc >= 0 && readSource() != origSrc) { sendRequestSource((byte) origSrc); line("requested source back to " + origSrc); }
        }

        line("\n==== SUMMARY ====");
        line("service already running at start : " + wasRunning);
        line("logcat readable (saw svc logs)  : " + logcatReadable);
        line("winning rung                    : " + (worked != null ? worked : "NONE"));
        line("\n" + summary);

        saveLog();
        line("==== DONE ====");
        testRunning = false;
    }

    private boolean audioYes(String rung) {
        return prompt(rung + ": is FM audio playing through the speakers now?", "YES — audio!", "No").startsWith("YES");
    }

    private void rungLog(String name, String before, String after, boolean yes) {
        summary.append(name).append('\n')
               .append("   before: ").append(before).append('\n')
               .append("   after : ").append(after).append('\n')
               .append("   USER  : ").append(yes ? "AUDIO YES" : "no").append("\n\n");
    }

    // ── Radio-functions test: tune · seek · RDS (run after audio is up) ─────────
    // On this AllWinner unit the AIDL is named counter-intuitively:
    //   search(up) -> seekStationAsync -> startScanThread : the REAL seek-to-station
    //   seek(up)   -> tuneStationAsync                    : a single manual STEP
    // The scan is gated on mPowerStatus==POWER_UP, so we power FM up first.
    private void runRadioFunc() {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(this::radioFuncBody, "nwd-radiofunc").start();
    }

    private void radioFuncBody() {
        line("\n==== RADIO FUNCTIONS TEST (tune · seek · RDS) ====");
        prompt("Tests tuning, seek/scan and RadioText while FM plays standalone.\n\n"
             + "• It WILL move between stations.\n"
             + "• Set the MHz box above to the station you want to test (a strong one that carries\n"
             + "  RadioText is best), THEN tap Start.", "Start");
        latchMhzField();
        wakeAndBind();
        for (int i = 0; radio == null && i < 16; i++) sleep(500);
        if (radio == null) { line("not bound — aborting"); testRunning = false; return; }

        // Seek/scan only runs when the tuner is POWER_UP — ensure that first.
        line("ensuring FM powered (ACTION_APP_IN_OUT app_id=8)…");
        sendAppInOut(8); sleep(3500);
        calibrate();
        richDump("radiofunc baseline");
        dumpAllBanks();   // FM1/FM2/FM3 (+AM) preset lists — see how AMS filled them

        // A — tune to a chosen station (prove we can pick the station standalone).
        line("\n-- A: tune to " + uiMhz + " (setCurrentFrequency) --");
        tuneMhzTo(uiMhz); watch("TUNE", 5000, 1000); captureLogcat("TUNE");
        prompt("A) Tuned to " + uiMhz + ". Is THAT station playing now?", "Yes", "No / wrong station");

        // B — search(up): the real hardware seek-to-next-station.
        line("\n-- B: search(up) = hardware SEEK to next station (the real seek) --");
        try { radio.search(true); line("called search(true)"); } catch (Exception e) { line("search failed " + e); }
        watch("SEEKUP", 9000, 1000); captureLogcat("SEEKUP");
        prompt("B) SEEK up — what happened?", "Stopped on a NEW station", "Only stepped once", "Nothing");

        // C — search(down).
        line("\n-- C: search(down) = seek to next station downward --");
        try { radio.search(false); line("called search(false)"); } catch (Exception e) { line("search failed " + e); }
        watch("SEEKDN", 9000, 1000); captureLogcat("SEEKDN");
        prompt("C) SEEK down — what happened?", "Stopped on a NEW station", "Only stepped once", "Nothing");

        // D — seek(up): the single manual step, for contrast.
        line("\n-- D: seek(up) = single manual STEP (not a station seek) --");
        try { radio.seek(true); line("called seek(true)"); } catch (Exception e) { line("seek failed " + e); }
        watch("STEP", 4000, 1000); captureLogcat("STEP");
        prompt("D) STEP up — what happened?", "Moved one small step", "Seeked to a station", "Nothing");

        // E — RDS dwell: sit on the current station and watch for RadioText / PS.
        line("\n-- E: RDS dwell 30s on the current station (watch rt='…' / PS) --");
        line("  (no text? set the MHz box to a station you KNOW carries RadioText, tap Tune, run again)");
        dwell("RDS", 30);
        captureLogcat("RDS");
        prompt("E) In those 30s, did any RadioText or station name appear (log rt='…'/PS, or on screen)?",
                "Yes, text appeared", "No text");

        richDump("radiofunc final");
        saveLog();
        line("==== RADIO FUNCTIONS DONE ====");
        testRunning = false;
    }

    // ── Overwrite the built-in preset banks from the "app" side (ONE-WAY: app→unit) ──
    // Demo list standing in for CarFM's presets: 18 ascending frequencies, so a
    // sequential fill (FM1[0..5], FM2[0..5], FM3[0..5]) steps low→high on the wheel.
    private static final double[] TEST_PRESETS = {
        88.1, 89.5, 90.7, 91.9, 93.3, 94.5,      // FM1
        96.1, 97.3, 98.9, 100.3, 101.5, 102.7,   // FM2
        103.9, 104.7, 105.5, 106.3, 107.1, 107.9 // FM3
    };

    private void runWritePresets() {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(this::writePresetsBody, "nwd-writepresets").start();
    }

    private void writePresetsBody() {
        line("\n==== OVERWRITE BUILT-IN PRESETS (app → unit) ====");
        String go = prompt("This OVERWRITES the head unit's built-in FM presets (FM1/FM2/FM3) with an "
                + "ascending test list. Your current built-in presets WILL be replaced. Continue?",
                "Overwrite", "Cancel");
        if (!"Overwrite".equals(go)) { line("cancelled"); testRunning = false; return; }

        wakeAndBind();
        for (int i = 0; radio == null && i < 16; i++) sleep(500);
        if (radio == null) { line("not bound — aborting"); testRunning = false; return; }
        line("ensuring FM powered (ACTION_APP_IN_OUT app_id=8)…");
        sendAppInOut(8); sleep(3500); calibrate();

        line("\n-- BEFORE --"); dumpAllBanks();

        int n = Math.min(TEST_PRESETS.length, 18);
        line("\n-- writing " + n + " presets (FM1/FM2/FM3, 6 each) via saveCurrentFrequency --");
        for (int i = 0; i < n; i++) {
            int band = i / 6, slot = i % 6;
            if (slot == 0) {
                line("  → switch to " + bankName(band));
                if (!gotoBand(band)) line("  WARN: could not reach " + bankName(band) + " (now on " + bankName(currentBand()) + ") — writes may land in the wrong bank");
            }
            tuneMhzTo(TEST_PRESETS[i]); sleep(1600);   // let mCurrentStation settle before save
            try { radio.saveCurrentFrequency((byte) slot); line("  wrote " + bankName(band) + " slot " + (slot + 1) + " = " + TEST_PRESETS[i]); }
            catch (Exception e) { line("  saveCurrentFrequency(" + slot + ") FAILED: " + e); }
            sleep(600);
        }

        line("\n-- AFTER --"); dumpAllBanks();
        prompt("Check the head unit's FM1/FM2/FM3 lists — do they now show the ascending test stations?",
                "Yes, overwritten", "No / partial");
        saveLog();
        line("==== OVERWRITE DONE ====");
        testRunning = false;
    }

    private int currentBand() {
        if (radio == null) return -1;
        try { Frequency f = radio.getCurrentFrequency(); return f != null ? f.band : -1; } catch (Exception e) { return -1; }
    }

    /** Advance changeBand() until we're on `target` (FM1=0/FM2=1/FM3=2). */
    private boolean gotoBand(int target) {
        for (int t = 0; t < 8; t++) {
            if (currentBand() == target) return true;
            try { radio.changeBand(); } catch (Exception e) { line("  changeBand err " + e); }
            sleep(1600);
        }
        return currentBand() == target;
    }

    /** Read the MHz box on the UI thread (view access must not be off-thread). */
    private void latchMhzField() {
        runOnUiThread(() -> { try { uiMhz = Double.parseDouble(mhzField.getText().toString().trim()); } catch (Exception ignored) {} });
        sleep(150);
    }

    /** FM1=0, FM2=1, FM3=2, then AM banks. arg is 1-6 WITHIN this bank; the bank is
     *  carried by notifyCurrentFrequency's separate `band` field / Frequency.band. */
    private static String bankName(int band) {
        switch (band) { case 0: return "FM1"; case 1: return "FM2"; case 2: return "FM3"; case 3: return "AM1"; case 4: return "AM2"; default: return "band" + band; }
    }

    /** Dump every preset bank. getPrefabFrequency() returns only the CURRENT bank's
     *  6 slots, so cycle changeBand() and read each (FM1/FM2/FM3/AM…). NOTE:
     *  changeBand retunes to each bank's last station as it goes; it wraps back
     *  after a full cycle. Ascending values in a bank = auto-stored by AMS. */
    private void dumpAllBanks() {
        if (radio == null) { line("dumpAllBanks: not bound"); return; }
        line("---- ALL PRESET BANKS (cycling changeBand) ----");
        for (int i = 0; i < 5; i++) {
            try {
                Frequency cf = radio.getCurrentFrequency();
                int band = cf != null ? cf.band : -1;
                Frequency[] pf = radio.getPrefabFrequency();
                StringBuilder sb = new StringBuilder("  band=" + band + "(" + bankName(band) + ") ");
                if (pf != null) {
                    sb.append('[').append(pf.length).append("] ");
                    for (int s = 0; s < pf.length; s++) {
                        sb.append(s + 1).append(':').append(pf[s].freq / (double) freqMult);
                        if (pf[s].psName != null && !pf[s].psName.isEmpty()) sb.append('/').append(pf[s].psName);
                        sb.append("  ");
                    }
                } else sb.append("(null)");
                line(sb.toString());
            } catch (Exception e) { line("  bank read err " + e); }
            try { radio.changeBand(); } catch (Exception e) { line("  changeBand err " + e); }
            sleep(1500);
        }
        line("  (cycled through all banks; ascending values in a bank = AMS auto-store)");
    }

    /** Sit on the current station for `seconds`, logging freq / PS / RadioText every 3s. */
    private void dwell(String tag, int seconds) {
        for (int i = 0; i < seconds; i += 3) {
            sleep(3000);
            StringBuilder s = new StringBuilder("  [" + tag + "] t+" + (i + 3) + "s");
            if (radio != null) {
                try { Frequency f = radio.getCurrentFrequency(); if (f != null) s.append(" freq=").append(f.freq / (double) freqMult).append(" PS='").append(f.psName).append('\''); } catch (Exception ignored) {}
                try { s.append(" rt='").append(radio.getRtMessage()).append('\''); } catch (Exception ignored) {}
                try { s.append(" pty=").append(radio.getPTYType()); } catch (Exception ignored) {}
            }
            line(s.toString());
        }
    }

    // ── Bring-up broadcasts (exact actions/extras from SprdRadioManager$1) ──────
    private void sendAppInOut(int appId) {
        Intent i = new Intent("com.nwd.action.ACTION_APP_IN_OUT");
        i.putExtra("extra_app_id", appId);
        i.putExtra("extra_app_operation", 1);
        i.putExtra("extra_app_event", 0);
        sendBroadcast(i);
        line("bcast ACTION_APP_IN_OUT extra_app_id=" + appId);
    }
    private void sendMediaPlay(int appId) {
        Intent i = new Intent("com.nwd.ACTION_MEDIA_PLAY");
        i.putExtra("extra_app_id", appId);
        sendBroadcast(i);
        line("bcast ACTION_MEDIA_PLAY extra_app_id=" + appId);
    }
    private void sendRequestSource(byte src) {
        Intent i = new Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE");
        i.putExtra("extra_source_id", src);
        sendBroadcast(i);
        line("bcast ACTION_REQUEST_CHANGE_SOURCE extra_source_id=" + src);
    }
    private void sendExitFm() { sendBroadcast(new Intent("com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO")); line("bcast ACTION_EXIT_ARM_FM_RAIDO"); }
    private void sendStopQqMusic() { sendBroadcast(new Intent("com.music.action.STOP_QQ_MUSIC")); line("bcast STOP_QQ_MUSIC (clear competing media)"); }

    private void tryVendorMediaPlayer() {
        try {
            if (vendorMp != null) { try { vendorMp.release(); } catch (Exception ignored) {} vendorMp = null; }
            vendorMp = new MediaPlayer();
            vendorMp.setAudioStreamType(AudioManager.STREAM_MUSIC);
            vendorMp.setDataSource("THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM");
            vendorMp.prepare();
            vendorMp.start();
            line("vendor MediaPlayer prepared+started");
        } catch (Throwable e) { line("vendor MediaPlayer failed (expected on most units): " + e); }
    }

    // ── Data capture ───────────────────────────────────────────────────────────
    /** Per-second state samples across a wait — catches the mute→unmute→powerUp arc. */
    private void watch(String tag, int totalMs, int stepMs) {
        int elapsed = 0;
        while (elapsed < totalMs) { sleep(stepMs); elapsed += stepMs; line("  [" + tag + "] t+" + elapsed + "ms " + stateLine()); }
    }

    /** Compact one-line tuner + audio state for before/after + time-series. */
    private String stateLine() {
        StringBuilder s = new StringBuilder();
        if (radio != null) {
            try { s.append("st=").append(radio.getRadioState()); } catch (Exception e) { s.append("st=err"); }
            try { s.append(" stereo=").append(radio.isStreroOn()); } catch (Exception ignored) {}
            try { String rt = radio.getRtMessage(); s.append(" rt='").append(rt == null ? "" : rt).append('\''); } catch (Exception ignored) {}
        } else s.append("(not bound)");
        s.append(" src=").append(readSource());
        if (am != null) {
            try { s.append(" music=").append(am.isMusicActive()); } catch (Exception ignored) {}
            try { s.append(" vol=").append(am.getStreamVolume(AudioManager.STREAM_MUSIC)); } catch (Exception ignored) {}
        }
        return s.toString();
    }

    private void audioSnap(String tag) {
        if (am == null) { line("AUDIO[" + tag + "] (no AudioManager)"); return; }
        StringBuilder s = new StringBuilder("AUDIO[" + tag + "]");
        try { s.append(" musicActive=").append(am.isMusicActive()); } catch (Exception ignored) {}
        try { s.append(" musicVol=").append(am.getStreamVolume(AudioManager.STREAM_MUSIC)).append('/').append(am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)); } catch (Exception ignored) {}
        try { s.append(" mode=").append(am.getMode()); } catch (Exception ignored) {}
        try { s.append(" a2dp=").append(am.isBluetoothA2dpOn()).append(" wired=").append(am.isWiredHeadsetOn()).append(" spk=").append(am.isSpeakerphoneOn()); } catch (Exception ignored) {}
        line(s.toString());
    }

    /** Full getter sweep + audio snapshot + hidden-parcel-field hunt. */
    private void richDump(String tag) {
        line("---- RICH DUMP: " + tag + " ----");
        if (radio == null) { line("  (not bound)"); }
        else {
            try { line("  radioType=" + radio.getRadioType() + " state=" + radio.getRadioState() + " scan=" + radio.getCurrentScanState()); } catch (Exception e) { line("  err " + e); }
            try { Frequency f = radio.getCurrentFrequency(); if (f != null) line("  freq raw=" + f.freq + " (" + (f.freq / (double) freqMult) + " MHz) band=" + f.band + " PS='" + f.psName + "'"); } catch (Exception e) { line("  freq err " + e); }
            try { line("  stereoOn=" + radio.isStreroOn() + " hasStereo=" + radio.isHasStrero() + " nearOn=" + radio.isNearOn() + " backSvc=" + radio.isRadioBackServiceOn()); } catch (Exception e) { line("  err " + e); }
            try { line("  pty=" + radio.getPTYType() + " prefabPty=" + radio.getPrefabPTYType() + " rt='" + radio.getRtMessage() + "'"); } catch (Exception e) { line("  err " + e); }
            StringBuilder rds = new StringBuilder();
            for (int s = 0; s < 4; s++) { try { rds.append(s).append('=').append(radio.getRDSState(s)).append(' '); } catch (Exception e) { rds.append(s).append("=err "); } }
            line("  rdsState " + rds);
            try { RadioPoint[] pts = radio.getRadioPoint(); if (pts != null) { StringBuilder sb = new StringBuilder(); for (RadioPoint p : pts) sb.append(p).append("; "); line("  bandPlan " + sb); } } catch (Exception e) { line("  bandplan err " + e); }
            try { Frequency[] pf = radio.getPrefabFrequency(); if (pf != null) { StringBuilder sb = new StringBuilder("[" + pf.length + "] "); for (Frequency p : pf) sb.append(p.freq).append('/').append(p.psName).append(','); line("  presets " + sb); } } catch (Exception e) { line("  presets err " + e); }
        }
        audioSnap(tag);
        rawFrequencyParcelDump();
    }

    /** RAW getCurrentFrequency reply: report bytes left over after {band, ps, freq}
     *  — those are fields our AIDL reconstruction truncates (a hidden RSSI/stereo/
     *  lock would show here, and would differ between a strong and a weak station). */
    private void rawFrequencyParcelDump() {
        if (radio == null) return;
        Parcel data = Parcel.obtain(), reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(RF_DESCRIPTOR);
            radio.asBinder().transact(TXN_GET_CURRENT_FREQ, data, reply, 0);
            reply.readException();
            int present = reply.readInt();
            if (present == 0) { line("  rawParcel: null result"); return; }
            byte band = reply.readByte();
            String ps = reply.readString();
            int freq = reply.readInt();
            int avail = reply.dataAvail();
            line("  rawParcel: band=" + band + " ps='" + ps + "' freq=" + freq + " | LEFTOVER=" + avail + (avail > 0 ? " bytes  <-- HIDDEN FIELDS" : " (none)"));
            StringBuilder extra = new StringBuilder();
            while (reply.dataAvail() >= 4) extra.append("int:").append(reply.readInt()).append(' ');
            while (reply.dataAvail() >= 1) extra.append("byte:").append((int) reply.readByte()).append(' ');
            if (extra.length() > 0) line("    leftover -> " + extra);
        } catch (Throwable e) { line("  rawParcel transact failed: " + e); }
        finally { reply.recycle(); data.recycle(); }
    }

    /** Dump the last of the system log, filtered to the service's own FM/audio trail.
     *  Only works if this app can read others' logs (root / READ_LOGS / permissive
     *  ROM) — otherwise reports "unreadable", which is itself a datum. */
    private void captureLogcat(String tag) {
        try {
            Process p = new ProcessBuilder("logcat", "-d", "-v", "time", "-t", "600").redirectErrorStream(true).start();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String ln; int n = 0, hit = 0;
            while ((ln = r.readLine()) != null) {
                n++;
                String low = ln.toLowerCase(Locale.US);
                if (low.contains("nwdprobe")) continue;   // skip our own lines (avoid feedback)
                if (low.contains("initfm") || low.contains("powerup") || low.contains("power up")
                        || low.contains("audiofocus") || low.contains("setforceuse") || low.contains("forceuse")
                        || low.contains("mpowerstatus") || low.contains("unmute") || low.contains("mutestream")
                        || low.contains("opendev") || low.contains("opendevice") || low.contains("enablefmaudio")
                        || low.contains("sprdfm") || low.contains("sprdradio") || low.contains("fmfeature")
                        || low.contains("changesource") || low.contains("initfm")) {
                    if (hit++ < 100) line("  LOGCAT[" + tag + "]| " + ln);
                }
            }
            r.close(); p.destroy();
            if (hit > 0) logcatReadable = true;
            line("  (logcat " + tag + ": " + (n == 0 ? "empty/unreadable — need root/READ_LOGS" : hit + " service hits of " + n + " lines") + ")");
        } catch (Throwable e) { line("  logcat capture failed (" + tag + "): " + e); }
    }

    private void getpropDump() {
        line("---- getprop (radio/fm/mcu/tuner/source/antenna) ----");
        try {
            Process p = Runtime.getRuntime().exec("getprop");
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String ln; int n = 0;
            while ((ln = r.readLine()) != null) {
                if (ln.toLowerCase(Locale.US).matches(".*(radio|fm|mcu|tuner|source|antenna).*")) { line("  " + ln); n++; }
            }
            r.close();
            line("  (" + n + " matching props)");
        } catch (Throwable e) { line("  getprop failed: " + e); }
    }

    private void calibrate() {
        if (radio == null) return;
        try {
            Frequency f = radio.getCurrentFrequency();
            if (f != null) { fmBand = f.band; int fv = f.freq; freqMult = fv > 50000 ? 1000 : fv > 5000 ? 100 : fv > 500 ? 10 : 1;
                line("calibrated freqMult=" + freqMult + " band=" + fmBand + " (from raw " + fv + ")"); }
        } catch (Exception e) { line("calibrate err " + e); }
    }

    private double currentMhz() {
        if (radio == null) return -1;
        try { Frequency f = radio.getCurrentFrequency(); if (f != null && f.freq > 0) return f.freq / (double) freqMult; }
        catch (Exception ignored) {}
        return -1;
    }

    private int readSource() { try { return Settings.System.getInt(getContentResolver(), SRC_KEY, -1); } catch (Exception e) { return -1; } }

    private void startSourceObserver() {
        if (sourceObserver != null) return;
        sourceObserver = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override public void onChange(boolean self) { line("OBS " + SRC_KEY + " -> " + readSource()); }
        };
        try { getContentResolver().registerContentObserver(Settings.System.getUriFor(SRC_KEY), false, sourceObserver); line("source observer on"); }
        catch (Exception e) { line("observer reg failed " + e); sourceObserver = null; }
    }

    private void startBroadcastLogger() {
        if (nwdRx != null) return;
        nwdRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                StringBuilder ex = new StringBuilder();
                Bundle b = i.getExtras();
                if (b != null) for (String k : b.keySet()) ex.append(k).append('=').append(b.get(k)).append(' ');
                line("BCAST " + i.getAction() + "  " + ex);
            }
        };
        IntentFilter f = new IntentFilter();
        for (String a : new String[]{
                "com.nwd.action.ACTION_APP_IN_OUT", "com.nwd.ACTION_MEDIA_PLAY",
                "com.nwd.action.ACTION_CHANGE_SOURCE", "com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE",
                "com.nwd.action.ACTION_SOURCE_CHANGED", "com.nwd.action.ACTION_MCU_STATE_CHANGE",
                "com.nwd.action.ACTION_MCU_POWER_OFF", "com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO",
                "com.nwd.action.ACTION_VOLUME_STATE_CHANGE", "com.nwd.radio.RDS" }) f.addAction(a);
        try {
            if (Build.VERSION.SDK_INT >= 34) registerReceiver(nwdRx, f, Context.RECEIVER_EXPORTED);
            else registerReceiver(nwdRx, f);
            line("broadcast logger on (" + f.countActions() + " actions)");
        } catch (Throwable e) { line("broadcast reg failed " + e); nwdRx = null; }
    }

    // ── Inline prompt primitive (called from the worker thread) ─────────────────
    private String prompt(String text, String... options) {
        line("Q: " + text.replace('\n', ' '));
        answer.clear();
        runOnUiThread(() -> {
            promptText.setText(text);
            promptButtons.removeAllViews();
            for (String opt : options) {
                Button b = new Button(this);
                b.setText(opt);
                b.setAllCaps(false);
                b.setOnClickListener(v -> {
                    answer.offer(opt);
                    promptButtons.removeAllViews();
                    promptText.setText("✓ " + opt);
                });
                b.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
                promptButtons.addView(b);
            }
            promptPanel.setVisibility(View.VISIBLE);
        });
        try { String a = answer.take(); line("A: " + a); return a; }
        catch (InterruptedException e) { return ""; }
    }

    // ── Manual tune ────────────────────────────────────────────────────────────
    private void tuneMhz() { try { fmBand = (byte) Integer.parseInt(bandField.getText().toString().trim()); tuneMhzTo(Double.parseDouble(mhzField.getText().toString().trim())); } catch (Exception e) { line("bad MHz/band: " + e); } }
    private void tuneMhzTo(double mhz) {
        if (radio == null) { line("not connected"); return; }
        try { int raw = (int) Math.round(mhz * freqMult); line("tune " + mhz + " (raw " + raw + ", band " + fmBand + ")"); radio.setCurrentFrequency(raw, fmBand, 0); }
        catch (RemoteException e) { line("tune FAILED: " + e); }
    }

    // ── Callbacks (Binder thread) ─────────────────────────────────────────────
    private final RadioCallback.Stub callback = new RadioCallback.Stub() {
        public void notifyState(byte s) { line("cb state " + s); }
        public void notifyCurrentFrequency(byte band, int freq, String ps, int arg) { line("cb FREQ " + (freq / (double) freqMult) + " PS='" + ps + "' band=" + band + "(" + bankName(band) + ") arg=" + arg + (arg >= 1 && arg <= 6 ? "  => " + bankName(band) + " slot " + arg : "  (not a preset in this bank)")); }
        public void notifyNearOn(boolean on) { line("cb nearOn " + on); }
        public void notifyStereo(boolean on) { line("cb stereo " + on); }
        public void notifyStereoOn(boolean on) { line("cb stereoOn " + on); }
        public void notifyRDSStateChange() { line("cb RDSStateChange"); }
        public void notifyCurrentPTYType(byte pty) { line("cb PTY " + pty); }
        public void notifyPrefabFrequency(Frequency[] a) { line("cb prefab[" + (a == null ? 0 : a.length) + "]"); }
        public void notifyPrefabPTYType(byte pty) { line("cb prefabPTY " + pty); }
        public void notifyRadioPoint(RadioPoint[] a) { line("cb radioPoint[" + (a == null ? 0 : a.length) + "]"); }
        public void notifyCurrentIsTA(boolean ta) { line("cb TA " + ta); }
        public void notifyRdsShowState(boolean on) { line("cb rdsShow " + on); }
        public void notifyRtMessage(String rt) { line("cb RT '" + rt + "'"); }
        public void notifyRadioScanState(int state) { line("cb scanState " + state); }
    };

    // ── Save / helpers ─────────────────────────────────────────────────────────
    private void saveLog() {
        String name = "nwdprobe-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".txt";
        String text; synchronized (logBuf) { text = logBuf.toString(); }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri != null) { OutputStream os = getContentResolver().openOutputStream(uri); os.write(text.getBytes()); os.close(); line("SAVED -> Downloads/" + name); return; }
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, name); FileOutputStream fo = new FileOutputStream(f); fo.write(text.getBytes()); fo.close();
            line("SAVED -> " + f.getAbsolutePath());
        } catch (Exception e) { line("save failed (screenshot the log instead): " + e); }
    }

    private void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
    private final SimpleDateFormat ts = new SimpleDateFormat("HH:mm:ss", Locale.US);
    private void line(final String s) {
        android.util.Log.i("nwdprobe", s);
        final String stamped = ts.format(new Date()) + "  " + s + "\n";
        synchronized (logBuf) { logBuf.append(stamped); }
        runOnUiThread(() -> {
            log.append(stamped);
            final int amount = log.getLayout() == null ? 0 : log.getLayout().getLineTop(log.getLineCount()) - log.getHeight();
            if (amount > 0) log.scrollTo(0, amount);
        });
    }
    private Button btn(String t, View.OnClickListener l) { Button b = new Button(this); b.setAllCaps(false); b.setText(t); b.setOnClickListener(l); return b; }
    private TextView label(String t) { TextView v = new TextView(this); v.setText(" " + t + " "); return v; }
    private View weighted(View v) { v.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f)); return v; }
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    @Override protected void onDestroy() {
        try { if (vendorMp != null) { vendorMp.release(); vendorMp = null; } } catch (Exception ignored) {}
        try { if (sourceObserver != null) getContentResolver().unregisterContentObserver(sourceObserver); } catch (Exception ignored) {}
        try { if (nwdRx != null) unregisterReceiver(nwdRx); } catch (Exception ignored) {}
        try { if (radio != null) radio.unRegistCallback(callback); } catch (Exception ignored) {}
        try { unbindService(conn); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
