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
 * NWD built-in FM tuner — standalone-radio probe (heavily instrumented).
 *
 * ONE big button, RUN ALL TESTS, runs three phases back to back as a guided
 * stream, with on-screen state reminders + yes/no questions (inline buttons):
 *   PHASE 1  standalone audio bring-up (can FM play with the stock app closed?)
 *   PHASE 2  tune · seek · RDS (station control, real seek, RadioText dwell)
 *   PHASE 3  overwrite the head unit's FM1/FM2/FM3 presets from the app side
 *            (ONE-WAY app→unit; nothing is ever read back into an app store)
 * Everything else (individual tests + manual controls) is under "Advanced".
 *
 * Key facts from decompiling com.nwd.radio.service (AllWinner path):
 *   • ACTION_APP_IN_OUT extra_app_id=8 -> AWFMFeature.InitFM() -> powerUp + route.
 *   • search(up) is the REAL seek-to-station; seek(up) is a single manual step;
 *     the scan is gated on POWER_UP (so power FM up first).
 *   • presets: mPrefFrequency[bank][0..5]; bank 0/1/2 = FM1/FM2/FM3 (18 FM slots);
 *     saveCurrentFrequency(slot 0-5) writes the current station into the cur bank.
 *   • notifyCurrentFrequency(band, freq, ps, arg): band = bank, arg = 1-6 slot.
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

        // The one button.
        Button runAllBtn = btn("▶  RUN ALL TESTS", v -> runAll());
        runAllBtn.setTextSize(18f);
        root.addView(runAllBtn);

        // Inline prompt panel — every on-screen instruction / question appears here.
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

        // Everything else lives under a collapsed "Advanced" section.
        final LinearLayout advanced = new LinearLayout(this);
        advanced.setOrientation(LinearLayout.VERTICAL);
        advanced.setVisibility(View.GONE);
        final Button advToggle = btn("Advanced ▾  (individual tests + manual controls)", null);
        advToggle.setOnClickListener(v -> {
            boolean show = advanced.getVisibility() != View.VISIBLE;
            advanced.setVisibility(show ? View.VISIBLE : View.GONE);
            advToggle.setText(show ? "Advanced ▴" : "Advanced ▾  (individual tests + manual controls)");
        });
        root.addView(advToggle);

        advanced.addView(btn("▶ Audio test only", v -> runAudioTest()));
        advanced.addView(btn("▶ Radio functions only (tune · seek · RDS)", v -> runRadioFunc()));
        advanced.addView(btn("▶ Overwrite presets only", v -> runWritePresets()));
        advanced.addView(btn("▶ Reclaim-after-loss test", v -> runReclaim()));
        advanced.addView(btn("Connect (bind service)", v -> wakeAndBind()));

        LinearLayout tuneRow = new LinearLayout(this);
        tuneRow.setOrientation(LinearLayout.HORIZONTAL);
        mhzField = new EditText(this); mhzField.setText(String.valueOf(STRONG_MHZ));
        mhzField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 2f));
        bandField = new EditText(this); bandField.setText("0");
        bandField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        tuneRow.addView(label("MHz")); tuneRow.addView(mhzField);
        tuneRow.addView(label("band")); tuneRow.addView(bandField);
        advanced.addView(tuneRow);

        LinearLayout manual = new LinearLayout(this);
        manual.setOrientation(LinearLayout.HORIZONTAL);
        manual.addView(weighted(btn("Tune", v -> tuneMhz())));
        manual.addView(weighted(btn("Dump banks", v -> new Thread(this::dumpAllBanks).start())));
        manual.addView(weighted(btn("Rich dump", v -> new Thread(() -> richDump("manual")).start())));
        manual.addView(weighted(btn("logcat", v -> new Thread(() -> captureLogcat("manual")).start())));
        manual.addView(weighted(btn("Save log", v -> saveLog())));
        advanced.addView(manual);

        LinearLayout bcRow = new LinearLayout(this);
        bcRow.setOrientation(LinearLayout.HORIZONTAL);
        bcRow.addView(weighted(btn("APP_IN_OUT 8", v -> sendAppInOut(8))));
        bcRow.addView(weighted(btn("MEDIA_PLAY 8", v -> sendMediaPlay(8))));
        bcRow.addView(weighted(btn("REQ SRC 4", v -> sendRequestSource((byte) 4))));
        bcRow.addView(weighted(btn("EXIT FM", v -> sendExitFm())));
        advanced.addView(bcRow);

        root.addView(advanced);

        log = new TextView(this);
        log.setTextSize(11f);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setTypeface(Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(log);
        root.addView(sv);

        setContentView(root);
        line("Ready. Stock radio app CLOSED, CarFM NOT running, volume UP, nothing else playing — then tap RUN ALL TESTS.");
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
     *  auto-create: it only connects if the process is already up. */
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

    // ── Test runners ────────────────────────────────────────────────────────────
    private void runAll()         { startWorker("nwd-all", this::runAllBody); }
    private void runAudioTest()   { runSolo("STANDALONE AUDIO", () -> phaseAudio()); }
    private void runRadioFunc()   { runSolo("RADIO FUNCTIONS", this::phaseRadioFunc); }
    private void runWritePresets(){ runSolo("OVERWRITE PRESETS", this::phaseWritePresets); }
    private void runReclaim()     { runSolo("RECLAIM AFTER LOSS", this::phaseReclaim); }

    private void startWorker(String name, Runnable body) {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(body, name).start();
    }

    /** Advanced-section single-phase runner: bind + baseline + one phase + save. */
    private void runSolo(String tag, Runnable phase) {
        startWorker("nwd-solo", () -> {
            line("\n==== " + tag + " (solo) ====");
            if (connectAndBaseline()) phase.run();
            saveLog(); line("==== DONE ===="); testRunning = false;
        });
    }

    /** The full guided run: three phases back to back on one shared bind. */
    private void runAllBody() {
        line("\n==== FULL PROBE RUN (all tests) ====");
        prompt("FULL PROBE RUN — expected state BEFORE starting:\n\n"
             + "• Stock radio app CLOSED.\n"
             + "• CarFM NOT running.\n"
             + "• Volume UP; nothing else playing (no Bluetooth audio, no music app).\n\n"
             + "Runs 3 phases back to back (~4-5 min): standalone audio → tune/seek/RDS → "
             + "overwrite presets. Follow the on-screen prompts.\n\nTap Start.", "Start");
        if (!connectAndBaseline()) { saveLog(); testRunning = false; return; }
        dumpAllBanks();   // current preset lists up front

        String worked = phaseAudio();
        phaseRadioFunc();
        phaseWritePresets();

        String c = prompt("All phases done. Turn the tuner audio back off?", "Stop FM", "Leave it playing");
        if ("Stop FM".equals(c)) sendExitFm();

        line("\n==== FULL RUN SUMMARY ====");
        line("audio winning rung : " + (worked != null ? worked : "NONE"));
        line("logcat readable    : " + logcatReadable);
        line("\n" + summary);
        saveLog();
        line("==== FULL RUN DONE ====");
        testRunning = false;
    }

    // ── Shared setup ────────────────────────────────────────────────────────────
    private boolean connectAndBaseline() {
        boolean wasRunning = preflightAlreadyRunning();
        wakeAndBind();
        for (int i = 0; radio == null && i < 16; i++) sleep(500);
        line("service bound = " + (radio != null) + "; was already running = " + wasRunning);
        if (radio == null) { line("NOT BOUND — is the head unit's radio service running? aborting"); return false; }
        richDump("baseline");
        getpropDump();
        return true;
    }

    private void ensurePowered() {
        line("ensuring FM powered (ACTION_APP_IN_OUT app_id=8)…");
        sendAppInOut(8); sleep(3500); calibrate();
    }

    // ── PHASE 1: standalone audio bring-up ladder ───────────────────────────────
    private String phaseAudio() {
        prompt("PHASE 1 — STANDALONE AUDIO.\n\nConfirms FM audio can start with the stock radio app CLOSED. "
             + "It tries a few triggers and asks 'is audio playing?' after each.\n\nTap Continue.", "Continue");
        sendStopQqMusic(); sleep(600); audioSnap("after STOP_QQ_MUSIC");
        String worked = null;

        {
            String before = stateLine();
            line("\n-- RUNG 1: ACTION_APP_IN_OUT extra_app_id=8  →  service InitFM() --");
            sendAppInOut(8);
            watch("RUNG1", 5000, 1000);
            captureLogcat("RUNG1"); audioSnap("after RUNG1");
            boolean y = audioYes("RUNG 1");
            rungLog("RUNG 1 — ACTION_APP_IN_OUT app_id=8", before, stateLine(), y);
            if (y) worked = "RUNG 1 — ACTION_APP_IN_OUT app_id=8";
        }
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
        if (worked == null) {
            String before = stateLine();
            line("\n-- RUNG 3: setCurrentFrequency (tune→powerUp) --");
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
        if (worked == null) {
            String before = stateLine();
            line("\n-- RUNG 5: MediaPlayer THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM (long shot) --");
            tryVendorMediaPlayer();
            watch("RUNG5", 4000, 1000); captureLogcat("RUNG5"); audioSnap("after RUNG5");
            boolean y = audioYes("RUNG 5");
            rungLog("RUNG 5 — vendor MediaPlayer URI", before, stateLine(), y);
            if (y) worked = "RUNG 5 — vendor MediaPlayer URI";
        }
        line("\n== PHASE 1 RESULT: " + (worked != null ? "AUDIO via " + worked : "NO rung produced audio") + " ==");
        richDump("audio-final");
        // Intentionally leave FM playing for phase 2 (don't stop here).
        return worked;
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

    // ── PHASE 2: tune · seek · RDS ──────────────────────────────────────────────
    private void phaseRadioFunc() {
        prompt("PHASE 2 — TUNE · SEEK · RDS.\n\nFM should be playing. It will tune, seek up/down, and watch "
             + "30s for RadioText. Default station is " + STRONG_MHZ + "; to use another (ideally one that "
             + "carries RadioText), set the MHz box under Advanced first.\n\nTap Continue.", "Continue");
        latchMhzField();
        ensurePowered();

        line("\n-- A: tune to " + uiMhz + " (setCurrentFrequency) --");
        tuneMhzTo(uiMhz); watch("TUNE", 5000, 1000); captureLogcat("TUNE");
        prompt("A) Tuned to " + uiMhz + ". Is THAT station playing now?", "Yes", "No / wrong station");

        line("\n-- B: search(up) = hardware SEEK to next station --");
        try { radio.search(true); line("called search(true)"); } catch (Exception e) { line("search failed " + e); }
        watch("SEEKUP", 9000, 1000); captureLogcat("SEEKUP");
        prompt("B) SEEK up — what happened?", "Stopped on a NEW station", "Only stepped once", "Nothing");

        line("\n-- C: search(down) = seek to next station downward --");
        try { radio.search(false); line("called search(false)"); } catch (Exception e) { line("search failed " + e); }
        watch("SEEKDN", 9000, 1000); captureLogcat("SEEKDN");
        prompt("C) SEEK down — what happened?", "Stopped on a NEW station", "Only stepped once", "Nothing");

        line("\n-- D: seek(up) = single manual STEP --");
        try { radio.seek(true); line("called seek(true)"); } catch (Exception e) { line("seek failed " + e); }
        watch("STEP", 4000, 1000); captureLogcat("STEP");
        prompt("D) STEP up — what happened?", "Moved one small step", "Seeked to a station", "Nothing");

        line("\n-- E: RDS dwell 30s (watch rt='…' / PS) --");
        dwell("RDS", 30); captureLogcat("RDS");
        prompt("E) In those 30s, did any RadioText / station name appear (log rt='…'/PS, or on screen)?",
                "Yes, text appeared", "No text");
        richDump("radiofunc-final");
    }

    // ── PHASE 3: overwrite built-in presets (ONE-WAY app→unit) ──────────────────
    // Demo list standing in for CarFM's presets: 18 ascending frequencies, so a
    // sequential fill (FM1[0..5], FM2[0..5], FM3[0..5]) steps low→high on the wheel.
    private static final double[] TEST_PRESETS = {
        88.1, 89.5, 90.7, 91.9, 93.3, 94.5,      // FM1
        96.1, 97.3, 98.9, 100.3, 101.5, 102.7,   // FM2
        103.9, 104.7, 105.5, 106.3, 107.1, 107.9 // FM3
    };

    private void phaseWritePresets() {
        String go = prompt("PHASE 3 — OVERWRITE BUILT-IN PRESETS (app → unit).\n\nREPLACES the head unit's "
             + "FM1/FM2/FM3 presets with an ascending test list (one-way; nothing is read back into any app). "
             + "Your current built-in presets WILL be replaced.\n\nContinue?", "Overwrite", "Skip");
        if (!"Overwrite".equals(go)) { line("overwrite skipped"); return; }
        ensurePowered();

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
    }

    // ── Reclaim-after-loss: can CarFM get audio BACK after another source takes over? ──
    // Mirrors the observed case: audio died when the stock app closed, and CarFM
    // tuning produced no sound. Compares tune-only reclaim (expected to fail) vs the
    // source-claim broadcast (expected to work — the fix CarFM needs).
    private void phaseReclaim() {
        prompt("RECLAIM-AFTER-LOSS.\n\nTests whether audio can be brought BACK after another source "
             + "(stock radio / Bluetooth) takes over — the case where audio died when the stock app "
             + "closed and CarFM tuning made no sound.\n\nTap Continue.", "Continue");
        latchMhzField();
        ensurePowered();
        audioSnap("reclaim: after claim");
        prompt("FM audio should be playing now (we just claimed the source). Is it?", "Yes", "No");

        prompt("Now MAKE ANOTHER SOURCE TAKE OVER, then let the FM audio STOP:\n\n"
             + "• Open the STOCK radio app, let it play ~10s, then CLOSE it\n"
             + "  (or switch to Bluetooth / AUX and back).\n\n"
             + "When the FM audio has stopped, tap Done.", "Done");
        richDump("reclaim: after source loss");
        prompt("Is the audio currently STOPPED (silent)?", "Yes, silent", "No, still playing");

        // Attempt A — tune only (no source claim). Expected to FAIL (matches your report).
        line("\n-- reclaim A: tune only (no source claim) --");
        tuneMhzTo(uiMhz); watch("RECLAIM-TUNE", 5000, 1000); captureLogcat("RECLAIM-TUNE");
        prompt("A) After tuning ALONE (no source claim) — did audio come back?", "Yes", "No");

        // Attempt B — ACTION_APP_IN_OUT app_id=8 (claim the source). Expected to WORK.
        line("\n-- reclaim B: ACTION_APP_IN_OUT app_id=8 (claim the FM source) --");
        sendAppInOut(8); watch("RECLAIM-CLAIM", 5000, 1000); captureLogcat("RECLAIM-CLAIM");
        prompt("B) After the source-claim broadcast — did audio come back?", "Yes", "No");
        richDump("reclaim: final");
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
     *  6 slots, so cycle changeBand() and read each (FM1/FM2/FM3/AM…). changeBand
     *  retunes to each bank's last station; it wraps back after a full cycle. */
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
            sleep(1600);
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

    // ── Bring-up broadcasts (exact actions/extras from the service receiver) ─────
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
            try { Frequency f = radio.getCurrentFrequency(); if (f != null) line("  freq raw=" + f.freq + " (" + (f.freq / (double) freqMult) + " MHz) band=" + f.band + "(" + bankName(f.band) + ") PS='" + f.psName + "'"); } catch (Exception e) { line("  freq err " + e); }
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

    /** RAW getCurrentFrequency reply: report bytes left over after {band, ps, freq}. */
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

    /** Dump the last of the system log, filtered to the service's own FM/audio trail. */
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
                        || low.contains("awfmfeature") || low.contains("awradio") || low.contains("sprdfm")
                        || low.contains("sprdradio") || low.contains("fmfeature") || low.contains("changesource")
                        || low.contains("scanwhole") || low.contains("strength") || low.contains("prefab")) {
                    if (hit++ < 120) line("  LOGCAT[" + tag + "]| " + ln);
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
