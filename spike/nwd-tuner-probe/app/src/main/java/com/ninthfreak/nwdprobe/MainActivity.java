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
 * ONE big button, RUN ALL TESTS, now runs a FOCUSED investigation — it no longer
 * re-tests what we've already confirmed (audio starts via app_id=8, tuning lands
 * on the right station, presets overwrite). It drives the three still-OPEN
 * questions, reading objective signals (isMusicActive / mcu_current_source /
 * frequency) instead of asking, except the one genuinely-open seek ear-check:
 *   A. RADIOTEXT  — can a bound client open the RDS decoder (mRdsEnable)?
 *   B. SEEK       — is there an on-demand seek outside the preset auto-search?
 *                   (characterizes BOTH seek() [single step] and search() [to-station])
 *   C. AUDIO-OFF  — which stop makes the MCU release Radio so audio STAYS off?
 * The old full phases (audio ladder, tune-confirm, overwrite presets, reclaim)
 * are preserved under "Advanced" — nothing was deleted, just taken off the default
 * run so it stops re-proving the known-good path.
 *
 * Key facts from decompiling com.nwd.radio.service (AllWinner path):
 *   • ACTION_APP_IN_OUT extra_app_id=8 (operation=1 IN / 0 OUT) -> InitFM/powerUp.
 *   • search(bool) scans and STOPS on the next station (on-demand seek); seek(bool)
 *     is a single step; both are gated on POWER_UP (so power FM up first).
 *   • RDS decode (analyzeBuiltInRadioRds) is gated on mRdsEnable && (mbDeviceOpen ||
 *     isRadioSource()); isRadioSource() reads mcu_current_source==4 (the MCU writes it).
 *   • audio is analog + MCU-routed: exiting FM doesn't stick while the active SOURCE
 *     is still Radio — the MCU re-powers it. Stopping means switching the source.
 *   • presets: saveCurrentFrequency(slot 0-5) writes the current station; band=bank.
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

    /** The focused investigation run. Everything we've ALREADY proven — audio can
     *  start (RUNG 1 = ACTION_APP_IN_OUT app_id=8), tuning lands on the right
     *  station, presets overwrite via AMS — is NOT re-tested here (those live under
     *  Advanced). It drives straight at the three things still OPEN:
     *    A. RadioText  — can we open the RDS decoder as a bound client?
     *    B. Seek       — is there an on-demand seek OUTSIDE the preset auto-search?
     *    C. Audio-off  — which stop actually makes the MCU let go, so it STAYS off?
     *  Objective signals (isMusicActive, mcu_current_source, frequency) are read
     *  directly — the only ear-question is the one genuinely-open seek check. */
    private void runAllBody() {
        line("\n==== NWD PROBE — focused investigation ====");
        prompt("NWD PROBE — before you start:\n\n"
             + "• Stock radio app CLOSED.\n"
             + "• Volume UP; nothing else playing.\n\n"
             + "This no longer re-tests what we've already confirmed. It investigates the three\n"
             + "open questions — RadioText, on-demand seek, and turning the audio off so it STAYS\n"
             + "off. ~3 min, mostly hands-off.\n\nTap Start.", "Start");
        if (!connectSlim()) { saveLog(); testRunning = false; return; }
        powerOnFm();   // known trigger; confirmed objectively, no "can you hear it?"

        investigateRds();
        investigateSeek();
        investigateAudioOff();

        line("\n==== SUMMARY ====");
        line("logcat readable : " + logcatReadable);
        line("\n" + summary);
        saveLog();
        line("==== DONE ====");
        testRunning = false;
    }

    /** Bind + a ONE-LINE state read. We know the AIDL map, so no baseline rich dump,
     *  no getprop sweep, no preset-bank cycling on the default run (all still under
     *  Advanced / Rich dump if ever needed). */
    private boolean connectSlim() {
        boolean wasRunning = preflightAlreadyRunning();
        wakeAndBind();
        for (int i = 0; radio == null && i < 16; i++) sleep(500);
        if (radio == null) { line("NOT BOUND — is the head unit's radio service running? aborting"); return false; }
        calibrate();
        line("bound (service was already running=" + wasRunning + ") — " + stateLine());
        return true;
    }

    /** Bring FM audio up via the KNOWN winner (ACTION_APP_IN_OUT app_id=8) and confirm
     *  it OBJECTIVELY with AudioManager.isMusicActive() — no "can you hear it?". Only
     *  falls back / asks if the objective check says there's genuinely no audio. */
    private boolean powerOnFm() {
        line("\n-- powering FM (ACTION_APP_IN_OUT app_id=8 — the confirmed trigger) --");
        sendStopQqMusic(); sleep(400);
        sendAppInOut(8); sleep(3500); calibrate();
        if (am != null && am.isMusicActive()) { line("  audio active (isMusicActive=true), on " + fmt(currentMhz()) + " src=" + readSource()); return true; }
        line("  isMusicActive=false — one retry with ACTION_MEDIA_PLAY…");
        sendMediaPlay(8); sleep(3000);
        if (am != null && am.isMusicActive()) { line("  audio active after MEDIA_PLAY, src=" + readSource()); return true; }
        return prompt("No audio detected automatically. Is it actually silent? (stock app closed, volume up?)",
                "It's playing", "It's silent").startsWith("It's playing");
    }

    // ── INVESTIGATION A: RadioText ──────────────────────────────────────────────
    // Known: a passive bound client gets rt=''. Last drive log showed we DID reach
    // mcu_current_source=4 (we're the FM source) yet mRdsEnable stayed false, so the
    // decoder never fed us. This walks the client-reachable levers that might flip
    // that and watches PS/RT/PTY — read from the tuner's own variables, no ear-check.
    private void investigateRds() {
        banner("INVESTIGATION A", "RADIOTEXT (RDS)",
               "A passive client sees no RadioText. Last run we were the FM source yet the decoder\n"
             + "(mRdsEnable=false) never fed us. This tries the levers that could open it — become\n"
             + "the source, keep the back-service alive — and watches whether PS/RT/PTY populate.");
        line("-- tuning " + STRONG_MHZ + " (strong local RDS) --");
        tuneMhzTo(STRONG_MHZ); sleep(2500);
        for (int s = 0; s < 4; s++) { try { radio.setRDSState((byte) s, true); } catch (Exception ignored) {} }

        line("\n-- lever 1: as-is, source=" + readSource() + " --");
        rdsRead("A1 as-is", 9); captureLogcat("RDS-A1");

        line("\n-- lever 2: setRadioBackServiceOn(true) + re-assert FM source --");
        try { radio.setRadioBackServiceOn(true); } catch (Exception e) { line("  backservice err " + e); }
        sendAppInOut(8); sleep(2500);
        line("  mcu_current_source now = " + readSource());
        rdsRead("A2 backsvc+source", 12); captureLogcat("RDS-A2");

        line("\n==> RadioText: mcu_current_source=" + readSource()
             + " — see the lever verdicts above (still empty = the decoder never reached the client).");
    }

    // ── INVESTIGATION B: seek OUTSIDE the preset auto-search ─────────────────────
    // The tuner seeks fine while auto-storing presets (AMS). Open question: can WE
    // trigger a seek on demand? The AIDL exposes two primitives — characterize BOTH:
    //   • radio.seek(bool)   — last log: a single 0.2 MHz step (does NOT find a station)
    //   • radio.search(bool) — last log: scanned and STOPPED on the next station
    // so we settle which one is the real on-demand "seek to next station".
    private void investigateSeek() {
        banner("INVESTIGATION B", "SEEK — on demand, outside the preset auto-search",
               "AMS seeks fine. Open question: can WE seek on demand? Two AIDL primitives:\n"
             + "  seek()   — expected a single frequency step\n"
             + "  search() — expected a real hop to the next station (this is the on-demand seek)\n"
             + "Reports exactly what each does; one ear-check on whether they land on a real station.");
        line("-- parking on 88.7 so a seek has room to run --");
        tuneMhzTo(88.7); sleep(1800);

        seekReport("seek() up",   true,  true);
        String a1 = prompt("After seek() up: CLEAR station (music/voice) or noise/silence?",
                "Clear station", "Noise / silence");
        summary.append("SEEK seek()-up audible: ").append(a1).append('\n');

        seekReport("seek() down", false, true);

        line("-- now the same, via search() (the on-demand seek-to-station) --");
        seekReport("search() up",   true,  false);
        String a2 = prompt("After search() up: CLEAR station or noise/silence?",
                "Clear station", "Noise / silence");
        summary.append("SEEK search()-up audible: ").append(a2).append('\n');
        seekReport("search() down", false, false);

        line("-- parking back on " + STRONG_MHZ + " --");
        tuneMhzTo(STRONG_MHZ); sleep(1200);
    }

    // ── INVESTIGATION C: turn audio OFF and make it STAY off ─────────────────────
    // The quirk: stop FM and the MCU re-powers it ~1s later because its active SOURCE
    // is still Radio (=4). EXIT_ARM_FM alone never sticks. This walks stop methods and
    // finds the one that makes the MCU let go — the exact signal CarFM's power button
    // must send. Each is watched 6s; source is read before/after.
    private void investigateAudioOff() {
        banner("INVESTIGATION C", "TURN AUDIO OFF — and make it STAY off",
               "Stop FM and it comes back a second later: the MCU's active source is still Radio.\n"
             + "This walks stop methods to find the one that sticks — what CarFM's power button needs.");
        if (!"Go".equals(prompt("Ready to test turning the audio OFF? (tries a few methods, ~30s)", "Go", "Skip"))) {
            line("audio-off investigation skipped"); summary.append("AUDIO-OFF: skipped\n"); return;
        }
        String winner = null;
        if (stopAndWatch("1. EXIT_ARM_FM (baseline — expected to come back)", this::sendExitFm)) winner = "EXIT_ARM_FM";
        if (winner == null) { ensurePowered(); if (stopAndWatch("2. APP_IN_OUT app_id=8 operation=0 (leave the FM source)", () -> sendAppInOut(8, 0))) winner = "APP_IN_OUT operation=0"; }
        if (winner == null) { ensurePowered(); if (stopAndWatch("3. REQUEST_CHANGE_SOURCE -> 0 (switch MCU off Radio)", () -> sendRequestSource((byte) 0))) winner = "REQUEST_CHANGE_SOURCE src=0"; }
        if (winner == null) { ensurePowered(); if (stopAndWatch("4. REQUEST_CHANGE_SOURCE -> 1", () -> sendRequestSource((byte) 1))) winner = "REQUEST_CHANGE_SOURCE src=1"; }

        line("\n==> AUDIO-OFF: " + (winner != null
                ? winner + " made the audio STAY off (source left Radio). ⇒ CarFM's power-off should send this."
                : "NONE stuck — MCU keeps re-powering; mcu_current_source=" + readSource() + " (still Radio). Needs a source switch the unit accepts."));
        summary.append("AUDIO-OFF sticks with: ").append(winner != null ? winner : "NONE found").append('\n');
    }

    /** Send a stop method, then watch ~6s: does audio STAY off, or does the MCU
     *  re-power it? Logs source + isMusicActive each second. Returns true iff it
     *  never came back on within the window. */
    private boolean stopAndWatch(String label, Runnable send) {
        boolean onBefore = am != null && am.isMusicActive();
        line("\n-- " + label + "  (before: music=" + onBefore + " src=" + readSource() + ") --");
        send.run();
        boolean cameBack = false;
        for (int t = 0; t < 6; t++) {
            sleep(1000);
            boolean on = am != null && am.isMusicActive();
            if (on) cameBack = true;
            line("   t+" + (t + 1) + "s music=" + on + " src=" + readSource());
        }
        boolean nowOn = am != null && am.isMusicActive();
        boolean stayedOff = !nowOn && !cameBack;
        line("   ==> " + (stayedOff ? "STAYED OFF ✓ (src=" + readSource() + ")"
                        : nowOn ? "still playing" : "flickered off then came back"));
        return stayedOff;
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
        banner("PHASE 1 of 3", "STANDALONE AUDIO",
               "Proves FM audio can START with the stock radio app CLOSED. Tries a ladder of\n"
             + "triggers and stops at the first that makes sound — the ONLY thing asked here is\n"
             + "'is audio playing?', because only your ears can confirm it.");
        prompt("Ready for Phase 1 (standalone audio)?", "Continue");
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

    // ── PHASE 2: tune · RDS · seek ──────────────────────────────────────────────
    // Distinct from Phase 1 (which only proves audio starts). This proves the app
    // can CONTROL the tuner: land on a chosen station (human ear confirms), read
    // whatever RDS the service exposes (decided from the variables, NOT asked), and
    // drive seek with a visible before→after frequency readout (no guessing).
    private void phaseRadioFunc() {
        banner("PHASE 2 of 3", "TUNE · RDS · SEEK",
               "Proves CarFM can DRIVE the built-in tuner: pick a station, read RDS, run seek.\n\n"
             + "You'll confirm by ear which station you land on. The RDS and seek results are read\n"
             + "straight from the tuner's own variables and shown in the log — no guesswork asked of you.");
        prompt("Ready for Phase 2 (tune / RDS / seek)?", "Continue");
        ensurePowered();

        // RDS enable: on this AllWinner unit setRDSState only toggles AF(1)/TA(2)
        // (not a PS/RT master switch), but enable everything we can and record the
        // states — captureLogcat shows whether the RDS DECODER (NewRdsManager) is
        // producing PS/RT internally even if none reaches us as a bound client.
        line("\n-- enabling RDS selectors (AF/TA are the only setRDSState levers here) --");
        for (int s = 0; s < 4; s++) { try { radio.setRDSState((byte) s, true); } catch (Exception ignored) {} }
        StringBuilder rs = new StringBuilder();
        for (int s = 0; s < 4; s++) { try { rs.append(s).append('=').append(radio.getRDSState(s)).append(' '); } catch (Exception e) { rs.append(s).append("=err "); } }
        line("  rdsState now " + rs);

        // WIBA 101.5 — tune, human confirms by ear, then AUTO-READ RDS (no question).
        tuneConfirm(101.5, "WIBA", "TUNE-WIBA");
        rdsRead("WIBA 101.5", 24); captureLogcat("RDS-WIBA");

        // WERN 88.7 — same.
        tuneConfirm(88.7, "WERN", "TUNE-WERN");
        rdsRead("WERN 88.7", 24); captureLogcat("RDS-WERN");

        // Seek — visible before→after, self-settling, decided from the frequency (no question).
        line("\n-- SEEK tests (each shows start → landed frequency; the tuner settles before we move on) --");
        seekReport("search up",   true,  false); captureLogcat("SEEKUP");
        seekReport("search down", false, false); captureLogcat("SEEKDN");
        seekReport("step up",     true,  true);  captureLogcat("STEP");

        // Park it back on a known station so it doesn't end mid-scan.
        line("-- parking back on WIBA 101.5 --");
        tuneMhzTo(101.5); sleep(1500);
        richDump("radiofunc-final");
    }

    /** Tune to a named station and ask the user to confirm they're hearing it. This
     *  is the one question worth asking — only a human ear can verify the tune
     *  actually landed on the right audible station. */
    private void tuneConfirm(double mhz, String call, String tag) {
        line("\n-- tune to " + call + " " + mhz + " --");
        tuneMhzTo(mhz); watch(tag, 5000, 1000); captureLogcat(tag);
        prompt("Tuned to " + call + " " + fmt(mhz) + ". Are you hearing " + call + "?",
                "Yes, correct station", "No / wrong / silent");
    }

    /** Read RDS for `seconds` and DECIDE from the tuner's own variables whether any
     *  PS / RadioText / PTY ever arrived — the app sees these before anything would
     *  hit a screen, so there's nothing to ask the user. Prints a verdict line. */
    private void rdsRead(String label, int seconds) {
        line("\n-- reading RDS on " + label + " for " + seconds + "s (PS / RadioText / PTY) --");
        String bestPs = "", bestRt = ""; int bestPty = -1;
        for (int i = 0; i < seconds; i += 3) {
            sleep(3000);
            String ps = "", rt = ""; int pty = -1;
            if (radio != null) {
                try { Frequency f = radio.getCurrentFrequency(); if (f != null && f.psName != null) ps = f.psName.trim(); } catch (Exception ignored) {}
                try { String m = radio.getRtMessage(); if (m != null) rt = m.trim(); } catch (Exception ignored) {}
                try { pty = radio.getPTYType(); } catch (Exception ignored) {}
            }
            if (!ps.isEmpty() && ps.length() > bestPs.length()) bestPs = ps;
            if (!rt.isEmpty() && rt.length() > bestRt.length()) bestRt = rt;
            if (pty > bestPty) bestPty = pty;
            line("  [" + label + "] t+" + (i + 3) + "s  PS='" + ps + "' RT='" + rt + "' PTY=" + pty);
        }
        boolean any = !bestPs.isEmpty() || !bestRt.isEmpty() || bestPty > 0;
        String verdict = any
            ? "RDS PRESENT — PS='" + bestPs + "' RT='" + bestRt + "' PTY=" + bestPty
            : "NO RDS reached the client (PS/RT/PTY all empty for " + seconds + "s)";
        line("  ==> " + label + ": " + verdict);
        summary.append("RDS ").append(label).append(": ").append(verdict).append('\n');
    }

    /** Drive seek and REPORT the outcome from the frequency itself: start → where it
     *  landed, whether that's a real hop or a single tick. Polls until the tuner
     *  stops moving (so it never "keeps slowly changing" waiting on the user), and
     *  asks nothing — the before→after readout is the evidence. */
    private void seekReport(String label, boolean up, boolean single) {
        if (radio == null) { line("  " + label + ": not bound"); return; }
        double before = currentMhz();
        line("\n-- " + label + " (from " + fmt(before) + ") --");
        try { if (single) radio.seek(up); else radio.search(up); }
        catch (Exception e) { line("  " + label + " call failed: " + e); return; }

        // Poll until the frequency holds steady for ~1.5s (3 equal reads) or we time out.
        double last = before, end = before; int stable = 0;
        for (int t = 0; t < 20 && stable < 3; t++) {
            sleep(500);
            double now = currentMhz();
            if (now > 0 && Math.abs(now - last) < 0.005) stable++;
            else { stable = 0; last = now; }
            if (now > 0) end = now;
        }
        String ps = "";
        try { Frequency f = radio.getCurrentFrequency(); if (f != null && f.psName != null) ps = f.psName.trim(); } catch (Exception ignored) {}
        double delta = Math.abs(end - before);
        String verdict = delta < 0.05  ? "no change — seek did nothing (" + fmt(before) + ")"
                       : delta <= 0.25 ? "stepped one tick: " + fmt(before) + " -> " + fmt(end)
                       :                 "landed on a station: " + fmt(before) + " -> " + fmt(end) + (ps.isEmpty() ? "" : " PS='" + ps + "'");
        line("  ==> " + label + ": " + verdict);
        summary.append("SEEK ").append(label).append(": ").append(verdict).append('\n');
    }

    // ── PHASE 3: overwrite built-in presets (ONE-WAY app→unit) ──────────────────
    // The user's real preset list (their order). 8 stations → FM1 slots 1-6 + FM2
    // slots 1-2; FM3 and later FM2 slots keep their prior contents.
    private static final double[] TEST_PRESETS = {
        101.5, 88.7, 105.9, 102.1, 104.1, 92.1,  // FM1
        94.9, 98.1                               // FM2 (slots 1-2)
    };

    private void phaseWritePresets() {
        banner("PHASE 3 of 3", "OVERWRITE PRESETS (app → unit)",
               "Proves CarFM can WRITE the head unit's own FM1/FM2/FM3 preset banks. Replaces them\n"
             + "with the app's 8-station list, ascending. One-way only — nothing is ever read back\n"
             + "into the app. The tuner audibly sweeps through the stations as it saves each slot.");
        String go = prompt("Phase 3 REPLACES your built-in FM presets with the app's list. Continue?",
                "Overwrite", "Skip");
        if (!"Overwrite".equals(go)) { line("overwrite skipped"); return; }
        ensurePowered();

        line("\n-- BEFORE --"); dumpAllBanks();
        int n = Math.min(TEST_PRESETS.length, 18);
        line("\n-- writing " + n + " presets across FM1/FM2/FM3 (6 per bank) via saveCurrentFrequency --");
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
        tuneMhzTo(101.5); watch("RECLAIM-TUNE", 5000, 1000); captureLogcat("RECLAIM-TUNE");
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

    /** One decimal place, US locale — for the human-facing frequency readouts. */
    private String fmt(double mhz) { return String.format(Locale.US, "%.1f", mhz); }

    /** A bold, visually distinct phase header so the three phases don't blur together —
     *  both on screen (the prompt panel) and in the saved log. */
    private void banner(String tag, String title, String what) {
        line("\n============================================================");
        line("  " + tag + "  —  " + title);
        line("------------------------------------------------------------");
        for (String ln : what.split("\n")) line("  " + ln);
        line("============================================================");
    }

    // ── Bring-up broadcasts (exact actions/extras from the service receiver) ─────
    private void sendAppInOut(int appId) { sendAppInOut(appId, 1); }   // operation=1 = app IN (claim FM source)
    /** operation: 1 = app IN (claim the FM source), 0 = app OUT (release it). */
    private void sendAppInOut(int appId, int operation) {
        Intent i = new Intent("com.nwd.action.ACTION_APP_IN_OUT");
        i.putExtra("extra_app_id", appId);
        i.putExtra("extra_app_operation", operation);
        i.putExtra("extra_app_event", 0);
        sendBroadcast(i);
        line("bcast ACTION_APP_IN_OUT extra_app_id=" + appId + " operation=" + operation);
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
                        || low.contains("scanwhole") || low.contains("strength") || low.contains("prefab")
                        || low.contains("newrds") || low.contains("rdsmanager") || low.contains("getlrtext")
                        || low.contains("lrtext") || low.contains("rtmessage") || low.contains("radiotext")
                        || low.contains("rds ") || low.contains("ps=") || low.contains("psname")) {
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
